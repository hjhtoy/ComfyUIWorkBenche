from support import html_path, launch_chromium
import asyncio, io, json, re, copy, time
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

root = Path(__file__).resolve().parent.parent
html = html_path().read_text()
graph = json.loads(re.search(r'id="workflow">(.*?)</script>', html, re.S)[1])


def renumber(data):
    keys = {k: str(int(k) + 500) for k in data}
    return {
        keys[k]: {
            **node,
            "inputs": {
                name: [keys[value[0]], value[1]] if isinstance(value, list) else value
                for name, value in node["inputs"].items()
            },
        }
        for k, node in data.items()
    }


async def main():
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context()
        page = await context.new_page()
        errors = []
        websockets = []
        reference_reads = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("websocket", lambda socket: websockets.append(socket.url))
        job = copy.deepcopy(graph)
        job["138"]["inputs"]["value"] = "角色<Picture 1>回头。\n再次看到<Picture 1>。"
        job["149"]["inputs"]["image"] = "folder/参考图.png"
        job["132"]["inputs"]["value"] = 12
        job["115"]["inputs"].update(megapixels=0.98, aspect_ratio="1:1 (Square)")
        for name in list(job["136"]["inputs"]):
            if name.startswith("ref_images.") and name != "ref_images.ref_image_0":
                del job["136"]["inputs"][name]
        job = renumber(job)
        foreign = copy.deepcopy(job)
        foreign["645"]["inputs"]["lora_name"] = "different.safetensors"
        blank = {"1": {"class_type": "SaveImage", "inputs": {}}}
        running = [
            [0, "ours", job, {"client_id": "original-comfy-ui"}],
            [1, "foreign", foreign, {}],
            [2, "blank", blank, {}],
        ]
        history = {}
        requests = []
        png = io.BytesIO()
        Image.new("RGB", (10, 10), "orange").save(png, format="PNG")

        async def route(r):
            url = r.request.url
            requests.append((r.request.method, url))
            headers = {"Access-Control-Allow-Origin": "*"}
            if "/system_stats" in url:
                return await r.fulfill(
                    json={"system": {}, "devices": []}, headers=headers
                )
            if "/queue" in url:
                return await r.fulfill(
                    json={
                        "queue_running": running,
                        "queue_pending": [[1, "pending", job, {}]],
                    },
                    headers=headers,
                )
            if "/history/ours" in url:
                return await r.fulfill(json=history, headers=headers)
            if "/view?" in url:
                if "type=input" in url:
                    reference_reads.append(url)
                return await r.fulfill(
                    body=png.getvalue(), content_type="image/png", headers=headers
                )
            return await r.fulfill(status=404, headers=headers)

        await context.route("http://127.0.0.1:8188/**", route)
        await page.goto(html_path().as_uri())
        await page.get_by_text("已载入 1 条服务器任务").wait_for()
        assert await page.locator(".job").count() == 1
        assert (
            " ".join((await page.locator(".job-metrics").inner_text()).split())
            == "1:1 · 1024 × 1024 · 12 秒 · 6 步"
        )
        assert not reference_reads
        await page.locator("#test").click()
        await page.get_by_text("已连接", exact=True).wait_for()
        await page.locator("#test").wait_for(state="visible")
        assert await page.locator(".job").count() == 1
        await page.locator(".job-name").click()
        await page.get_by_text("草稿已保存").wait_for()
        assert (
            await page.evaluate("snapshot().prompt")
            == "角色<Picture 1>回头。\n再次看到<Picture 1>。"
        )
        assert any("subfolder=folder" in url for url in reference_reads)
        assert not websockets
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert await page.locator(".job").count() == 1
        assert await page.evaluate("jobs[0].id") == "ours"
        now = int(time.time() * 1000)
        running.clear()
        history["ours"] = {
            "status": {
                "completed": True,
                "status_str": "success",
                "messages": [
                    ["execution_start", {"timestamp": now - 91000}],
                    ["execution_success", {"timestamp": now}],
                ],
            },
            "outputs": {
                "152": {"gifs": [{"filename": "result.mp4", "type": "output"}]}
            },
        }
        await page.get_by_text("已完成", exact=True).wait_for()
        assert await page.get_by_text("总耗时 01:31", exact=True).count() == 1
        assert (
            await page.locator(".job")
            .get_by_role("button", name="下载", exact=True)
            .is_visible()
        )
        assert not errors, errors
        assert all(method == "GET" for method, _ in requests)
        print(
            "PASS: startup and retest, same workflow with remapped node IDs, reject unrelated/pending, deduplicate after reload, restore server image/repeated tags, poll completion and elapsed time, no cross-client WebSocket"
        )
        await browser.close()


asyncio.run(main())
