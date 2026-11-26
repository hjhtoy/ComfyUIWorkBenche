"""Verify how running jobs recover when ComfyUI restarts or becomes unreachable."""
import asyncio
import sys
import tempfile
import time
from pathlib import Path

from aiohttp import ClientSession, web

from support import ROOT

sys.path.insert(0, str(ROOT))
from workspace.store import Store
from workspace.worker import Worker


async def listen(app):
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


async def wait_for(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.1)
    return False


def add_job(store, client, base, **extra):
    store.insert_job(
        "pika-h3",
        {
            "client": client,
            "base": base,
            "state": "queued",
            "sent": True,
            "id": client,
            "n": len(store.jobs()) + 1,
            "title": client,
            **extra,
        },
    )


async def verify():
    with tempfile.TemporaryDirectory() as folder:
        store = Store(Path(folder) / "data")
        state = {"fail": False, "queue": [], "history": {}, "reject": False}

        async def comfy(request):
            if state["fail"]:
                raise web.HTTPServiceUnavailable()
            if request.path == "/prompt":
                if state["reject"]:
                    return web.json_response(
                        {
                            "error": {"message": "Prompt outputs failed validation"},
                            "node_errors": {
                                "119": {
                                    "errors": [
                                        {
                                            "message": "Value not in list",
                                            "details": "vae_name: 'h3_vae.safetensors' not in (list of length 27)",
                                        }
                                    ]
                                }
                            },
                        },
                        status=400,
                    )
                # Some gateways accept the submission but answer with an empty object.
                return web.json_response({})
            if request.path == "/queue":
                return web.json_response(
                    {"queue_running": state["queue"], "queue_pending": []}
                )
            if request.path.startswith("/history"):
                return web.json_response(state["history"])
            return web.json_response({})

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", comfy)
        runner, base = await listen(app)
        http = ClientSession()
        worker = Worker(store, http)
        task = asyncio.create_task(worker.run())
        try:
            # A job the restarted ComfyUI no longer knows must converge, not spin forever.
            add_job(
                store,
                "gone",
                base,
                warn="工作区将重试：Cannot connect to host 127.0.0.1:7860",
            )
            assert await wait_for(lambda: store.job("gone")["state"] == "lost"), store.job("gone")
            gone = store.job("gone")
            assert "重启" in gone["note"], gone
            assert not gone.get("warn"), gone

            # A job still present in the queue is refreshed once the server answers.
            state["queue"] = [[0, "alive", {}, {"client_id": "alive"}]]
            add_job(store, "alive", base)
            assert await wait_for(lambda: store.job("alive")["state"] == "running"), store.job("alive")
            assert worker.connection == "", worker.connection

            # A failing server produces one shared note, never a warning on each card.
            state["fail"] = True
            store.change("alive", state="queued")
            assert await wait_for(lambda: worker.connection, 8), worker.connection
            assert not store.job("alive").get("warn"), store.job("alive")

            # Recovery clears the note and refreshes the job state automatically.
            state["fail"] = False
            assert await wait_for(
                lambda: worker.connection == ""
                and store.job("alive")["state"] == "running"
            ), (worker.connection, store.job("alive"))

            # A gateway that accepts /prompt but answers with {} keeps the job
            # queued instead of losing it during a slow cloud cold start.
            store.insert_job(
                "pika-h3",
                {
                    "client": "cloud",
                    "base": base,
                    "state": "local",
                    "n": 10,
                    "title": "cloud",
                    "sent": False,
                },
                {
                    "workflow": "pika-h3",
                    "batch": "b1",
                    "graph": {"1": {"class_type": "EmptyImage", "inputs": {}}},
                    "inputs": [],
                },
            )
            assert await wait_for(
                lambda: store.job("cloud")["state"] == "queued", 12
            ), store.job("cloud")
            cloud = store.job("cloud")
            assert cloud.get("id") is None and "已提交" in cloud["note"], cloud
            await asyncio.sleep(3)
            assert store.job("cloud")["state"] == "queued", store.job("cloud")

            # A validation failure keeps its node detail in one readable line.
            state["reject"] = True
            store.insert_job(
                "pika-h3",
                {
                    "client": "bad",
                    "base": base,
                    "state": "local",
                    "n": 11,
                    "title": "bad",
                    "sent": False,
                },
                {
                    "workflow": "pika-h3",
                    "batch": "b2",
                    "graph": {"1": {"class_type": "EmptyImage", "inputs": {}}},
                    "inputs": [],
                },
            )
            assert await wait_for(
                lambda: store.job("bad")["state"] == "failed", 12
            ), store.job("bad")
            bad = store.job("bad")
            assert "节点 119" in bad["note"] and "h3_vae" in bad["note"], bad
            assert "{" not in bad["note"] and "node_errors" not in bad["note"], bad
            state["reject"] = False

            # A permanently dead address must converge instead of pinning the
            # queue banner forever, and the note must name the address.
            import workspace.worker as worker_module

            worker_module.CONN_GIVE_UP = 3
            stale = "http://127.0.0.1:9"
            add_job(store, "stale", stale)
            assert await wait_for(
                lambda: store.job("stale")["state"] == "lost", 25
            ), store.job("stale")
            lost = store.job("stale")
            assert "已停止跟踪" in lost["note"] and stale in lost["note"], lost
            assert not lost.get("warn"), lost
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await http.close()
            await runner.cleanup()
        print(
            "PASS: lost jobs converge, transport errors stay off job cards and recovery refreshes state"
        )


asyncio.run(verify())
