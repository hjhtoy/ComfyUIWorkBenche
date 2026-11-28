from support import html_path, launch_chromium
import asyncio, io
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent


async def main():
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        page = await browser.new_page(viewport={"width": 1200, "height": 900})
        posted = []
        errors = []
        history = {}
        pending = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        picture = io.BytesIO()
        Image.new("RGB", (32, 20), "orange").save(picture, format="PNG")

        async def handler(route):
            url = route.request.url
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            }
            if route.request.method == "OPTIONS":
                return await route.fulfill(status=204, headers=headers)
            if "/system_stats" in url:
                return await route.fulfill(
                    json={"system": {}, "devices": []}, headers=headers
                )
            if "/queue" in url:
                return await route.fulfill(
                    json={"queue_running": [], "queue_pending": pending},
                    headers=headers,
                )
            if "/prompt" in url:
                request = route.request.post_data_json
                posted.append(request["prompt"])
                id = request["prompt_id"]
                pending.append(
                    [
                        len(posted),
                        id,
                        request["prompt"],
                        {"client_id": request["client_id"]},
                    ]
                )
                return await route.fulfill(json={"prompt_id": id}, headers=headers)
            if "/history/" in url:
                return await route.fulfill(json=history, headers=headers)
            if "/view?" in url:
                return await route.fulfill(
                    body=picture.getvalue(), content_type="image/png", headers=headers
                )
            return await route.fulfill(status=404, headers=headers)

        await page.route("http://127.0.0.1:8188/**", handler)
        await page.goto(html_path("image.html").as_uri())
        assert not await page.evaluate("Boolean(window.injected)")
        assert "</script>" in await page.locator("#editor").inner_text()
        assert await page.locator("#openBatch").is_hidden()
        assert (
            await page.locator("#refTools").is_hidden()
            and await page.locator("#duration").is_hidden()
        )
        assert await page.locator("#steps").input_value() == "20"
        assert await page.locator("#size option:checked").inner_text() == "512 × 512"
        await page.get_by_role("button", name="测试连接").click()
        await page.get_by_text("已连接", exact=True).wait_for()
        await page.locator("#editor").fill("第一条：山谷")
        await page.locator("#size").select_option(label="768 × 512")
        await page.locator("#steps").fill("17")
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[0]?.id")
        await page.locator("#editor").fill("第二条：城市")
        assert await page.locator("#size").locator("option").filter(has_text="1920 × 1080").count() == 1
        await page.locator("#size").select_option("custom")
        await page.locator("#width").fill("896")
        await page.locator("#height").fill("1152")
        await page.locator("#steps").fill("25")
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[1]?.id")
        assert [data["6"]["inputs"]["text"] for data in posted] == [
            "第一条：山谷",
            "第二条：城市",
        ]
        assert [data["3"]["inputs"]["steps"] for data in posted] == [17, 25]
        assert [
            (data["5"]["inputs"]["width"], data["5"]["inputs"]["height"])
            for data in posted
        ] == [(768, 512), (896, 1152)]
        assert all(
            data["7"]["inputs"]["text"] == "negative fixture"
            and list(data) == list(posted[0])
            for data in posted
        )
        id = pending.pop()[1]
        history[id] = {
            "status": {"completed": True, "status_str": "success"},
            "outputs": {"9": {"images": [{"filename": "test.png", "type": "output"}]}},
        }
        await page.get_by_text("已完成", exact=True).wait_for()
        await page.locator(".job").first.locator(".job-cover").click()
        await page.wait_for_function(
            "document.querySelector('#playerStage img')?.naturalWidth===32"
        )
        assert await page.locator("#player video").count() == 0
        await page.locator("#reuse").click()
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert await page.locator("#size").input_value() == "custom"
        assert await page.locator("#width").input_value() == "896"
        assert await page.locator("#height").input_value() == "1152"
        assert await page.locator("#editor").inner_text() == "第二条：城市"
        await page.set_viewport_size({"width": 390, "height": 844})
        assert await page.evaluate("document.documentElement.scrollWidth===innerWidth")
        assert not errors, errors
        await browser.close()
        print(
            "PASS: new image graph, embedded JSON escaping, no irrelevant controls, independent submissions, image preview, reuse and restored draft"
        )


asyncio.run(main())
