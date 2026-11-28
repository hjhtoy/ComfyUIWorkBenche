"""RunningHub OpenAPI: upload assets, create a task, poll outputs and archive files."""
import asyncio
import io
import json
import sys
import tempfile
import time
from pathlib import Path

from aiohttp import ClientSession, web
from PIL import Image

from support import ROOT

sys.path.insert(0, str(ROOT))
from workspace.store import Store
from workspace.worker import Worker, output_key


async def listen(app):
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


async def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.1)
    return False


async def verify():
    image = io.BytesIO()
    Image.new("RGB", (18, 12), "seagreen").save(image, "PNG")
    png = image.getvalue()

    with tempfile.TemporaryDirectory() as folder:
        temp = Path(folder)
        store = Store(temp / "data")
        created = {}
        uploads = []
        polls = {"count": 0}

        async def openapi(request):
            if request.path == "/task/openapi/upload":
                form = await request.post()
                uploads.append(
                    {
                        "apiKey": form.get("apiKey"),
                        "fileType": form.get("fileType"),
                        "name": form["file"].filename,
                        "size": len(form["file"].file.read()),
                    }
                )
                return web.json_response(
                    {"code": 0, "msg": "success",
                     "data": {"fileName": "api/ref.png", "fileType": "input"}}
                )
            if request.path == "/task/openapi/create":
                created.update(await request.json())
                return web.json_response(
                    {"code": 0, "msg": "success",
                     "data": {"taskId": "task-42", "taskStatus": "QUEUED"}}
                )
            if request.path == "/task/openapi/outputs":
                polls["count"] += 1
                if polls["count"] < 2:
                    return web.json_response(
                        {"code": 0, "msg": "success",
                         "data": {"taskStatus": "QUEUED", "netWssUrl": ""}}
                    )
                base = f"http://127.0.0.1:{request.transport.get_extra_info('sockname')[1]}"
                return web.json_response(
                    {"code": 0, "msg": "success",
                     "data": [{"fileUrl": base + "/files/out.png",
                               "fileType": "png", "nodeId": "6"}]}
                )
            if request.path == "/task/openapi/cancel":
                return web.json_response({"code": 0, "msg": "success", "data": None})
            if request.path == "/files/out.png":
                return web.Response(body=png, content_type="image/png")
            return web.json_response({"code": 0, "data": None})

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", openapi)
        runner, base = await listen(app)
        http = ClientSession()
        worker = Worker(store, http, lambda _workflow: temp / "out")
        store.set_secret("runninghub", "rh-test-key")

        # A stored asset the plan refers to.
        asset = store.root / "assets" / "aa" / "ref.png"
        asset.parent.mkdir(parents=True)
        asset.write_bytes(png)
        with store.db:
            store.db.execute(
                "INSERT INTO media(key,path,name,mime) VALUES(?,?,?,?)",
                ("material:1", "assets/aa/ref.png", "ref.png", "image/png"),
            )

        store.insert_job(
            "pika-h3",
            {"client": "rh", "base": base, "provider": "runninghub",
             "state": "local", "n": 1, "title": "rh"},
            {
                "workflow": "pika-h3",
                "batch": "b1",
                "graph": {
                    "5": {"class_type": "LoadImage", "inputs": {"image": ""}},
                    "6": {"class_type": "SaveImage", "inputs": {"filename_prefix": "x"}},
                },
                "inputs": [{"key": "material:1", "fields": [["5", "image"]]}],
                "nodeInfoList": [
                    {"nodeId": "5", "fieldName": "image", "fieldValue": ""}
                ],
                "runninghubWorkflowId": "123456789",
            },
        )
        task = asyncio.create_task(worker.run())
        try:
            assert await wait_for(
                lambda: store.job("rh").get("mediaNote") == "已保存到工作区", 25
            ), store.job("rh")
            job = store.job("rh")
            assert job["state"] == "done", job
            assert job["id"] == "task-42", job
            assert job["results"][0]["kind"] == "image", job["results"]
            # The uploaded file name replaced the placeholder in nodeInfoList.
            assert created["workflowId"] == "123456789", created
            assert created["nodeInfoList"][0]["fieldValue"] == "api/ref.png", created
            assert created["apiKey"] == "rh-test-key", created
            assert uploads and uploads[0]["name"] == "ref.png", uploads
            # The downloaded result is stored and exposed with a readable name.
            assert store.media(output_key(job, job["results"][0])), job["results"]
            exported = temp / "out" / "rh.png"
            assert exported.is_file() and exported.read_bytes() == png, exported
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await http.close()
            await runner.cleanup()
        print(
            "PASS: RunningHub OpenAPI uploads assets, applies nodeInfoList, polls outputs and archives results"
        )


asyncio.run(verify())
