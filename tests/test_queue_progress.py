"""Hosted queue: the running node and its step counter come from ComfyUI's WebSocket."""
import asyncio
import io
import json
import sys
import tempfile
from pathlib import Path

import aiohttp
from aiohttp import web
from PIL import Image
from playwright.async_api import async_playwright

from support import ROOT, launch_chromium

sys.path.insert(0, str(ROOT))
from workspace.server import create_app


async def listen(app):
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


async def verify(temp):
    image = io.BytesIO()
    Image.new("RGB", (18, 14), "olive").save(image, format="PNG")
    png = image.getvalue()
    sockets = []
    queue = []
    history = {}

    remote = web.Application()

    async def comfy(req):
        if req.path == "/ws":
            ws = web.WebSocketResponse()
            await ws.prepare(req)
            sockets.append(ws)
            async for _ in ws:
                pass
            return ws
        if req.path == "/upload/image":
            form = await req.post()
            return web.json_response({"name": "ref.png", "subfolder": "in"})
        if req.path == "/prompt":
            data = await req.json()
            queue.append([1, data["prompt_id"], data["prompt"], {"client_id": data["client_id"]}])
            return web.json_response({"prompt_id": data["prompt_id"]})
        if req.path == "/queue":
            return web.json_response({"queue_running": queue, "queue_pending": []})
        if req.path.startswith("/history"):
            return web.json_response(history)
        return web.json_response({"system": {}, "devices": []})

    remote.router.add_route("*", "/{tail:.*}", comfy)
    cr, base = await listen(remote)
    runner, url = await listen(
        create_app(temp / "data", ROOT / "dist" / "Frameform.html", outputs=temp / "out")
    )
    try:
        async with async_playwright() as p:
            browser = await launch_chromium(p)
            page = await browser.new_page(viewport={"width": 1280, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(url)
            await page.locator("#server").fill(base)
            await page.locator("#editor").fill("进度条测试")
            await page.locator("#generate").click()
            await page.locator(".job").first.wait_for()
            # The worker opens a socket with the submitted client id.
            for _ in range(80):
                if sockets:
                    break
                await asyncio.sleep(0.1)
            assert sockets, "worker never connected to /ws"
            for ws in sockets:
                await ws.send_json(
                    {
                        "type": "executing",
                        "data": {"node": "132", "prompt_id": queue[0][1]},
                    }
                )
                await ws.send_json(
                    {
                        "type": "progress",
                        "data": {"node": "132", "value": 2, "max": 6, "prompt_id": queue[0][1]},
                    }
                )
            card = page.locator(".job").first
            await card.get_by_text("2 / 6 步").wait_for()
            stage = await card.locator(".job-stage").inner_text()
            assert "2 / 6 步" in stage, stage
            assert await card.locator("progress").get_attribute("value") == "2", stage
            assert await card.locator("progress").get_attribute("max") == "6", stage
            # The server exposes the same snapshot for other windows.
            async with aiohttp.ClientSession() as session:
                async with session.get(url + "/workspace/progress") as res:
                    clients = (await res.json())["clients"]
            entry = next(iter(clients.values()))
            assert entry["value"] == 2 and entry["max"] == 6, entry
            # Completing the job clears the live line.
            history[queue[0][1]] = {
                "prompt": queue[0],
                "status": {"completed": True},
                "outputs": {"152": {"images": [{"filename": "done.png", "subfolder": "", "type": "output"}]}},
            }
            queue.clear()
            await page.get_by_text("已完成", exact=True).wait_for()
            await page.wait_for_function("!document.querySelector('.job-stage').textContent")
            assert not errors, errors
            await browser.close()
    finally:
        await cr.cleanup()
        await runner.cleanup()
    print("PASS: hosted queue shows the running node and 2 / 6 steps")


with tempfile.TemporaryDirectory(dir=ROOT) as folder:
    asyncio.run(verify(Path(folder)))
