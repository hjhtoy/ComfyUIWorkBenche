"""Import one storyboard TXT and preserve its filename, duration and picture bindings."""
import asyncio
import io
import sys

from PIL import Image
from playwright.async_api import async_playwright

from support import ROOT, launch_chromium

STORY = """subject_definitions:
<Subject 1> 是场景。文件 E02_临街朝柜_取景板.png，见 <Picture 1>。
<Subject 2> 是长衫主顾。文件 A10_长衫主顾_四视图.png as <Picture 2>。
[Shot 1] <Subject 1> 取景，<Subject 2> 落座。
镜头保持到本片 12.00 秒处结束。"""

MISSING = """本镜取景：不存在_另一张.png，见 <Picture 1>。
镜头保持到本片 8 秒处结束。"""


async def main():
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        page = await browser.new_page(viewport={"width": 1240, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto((ROOT / "dist/tests/Frameform.html").as_uri())
        await page.locator("#editor").wait_for()

        def image_file(name, color):
            buffer = io.BytesIO()
            Image.new("RGB", (8, 8), color).save(buffer, format="PNG")
            return {"name": name, "mimeType": "image/png", "buffer": buffer.getvalue()}

        async def add_material(name, color):
            # Import into the library without inserting a chip yet.
            await page.locator("#addRef").click()
            await page.locator("#file").set_input_files(image_file(name, color))
            await page.wait_for_function("!document.querySelector('#file').files.length")
            await page.locator("#closePicker").click()
            await page.locator("#picker").wait_for(state="hidden")

        await add_material("E02_临街朝柜_取景板.png", "olive")
        await add_material("A10_长衫主顾_四视图.png", "navy")
        await page.locator("#editor").fill("")
        assert await page.locator("#importTxt").is_visible()

        async def upload(name, body):
            await page.locator("#txtFile").set_input_files(
                {
                    "name": name,
                    "mimeType": "text/plain",
                    "buffer": body.encode(),
                }
            )

        first_name = "S01_四文落柜_12s.txt"
        await upload(first_name, STORY)
        await page.locator("#formError.success").wait_for()
        assert "2 个素材" in await page.locator("#formError").inner_text()
        assert await page.evaluate("snapshot().title") == first_name

        chips = page.locator("#editor .mention")
        assert await chips.count() == 2, await chips.all_inner_texts()
        assert await chips.nth(0).inner_text() == "E02_临街朝柜_取景板.png"
        assert await chips.nth(1).inner_text() == "A10_长衫主顾_四视图.png"
        assert (await page.locator("#refUsage").inner_text()).startswith("图片 2/9")

        prompt = await page.evaluate("snapshot().prompt")
        assert prompt.startswith("subject_definitions:"), prompt
        assert "<Picture 1>" in prompt and "<Picture 2>" in prompt, prompt
        # The filenames and their connectors are gone, only the tags remain.
        assert "取景板.png" not in prompt and " as " not in prompt, prompt
        assert "，见 <Picture" not in prompt, prompt
        # The storyboard duration drives the control.
        assert await page.locator("#duration").input_value() == "12"
        assert "12" in await page.locator("#timing").inner_text()

        await page.reload()
        await page.locator("#editor .mention").first.wait_for()
        assert await page.evaluate("snapshot().title") == first_name

        # A missing picture reports the exact file and leaves the draft alone.
        await upload("S02_缺图_8s.txt", MISSING)
        await page.get_by_text("assets 中找不到 不存在_另一张.png", exact=False).wait_for()
        assert await chips.count() == 2
        assert await page.locator("#duration").input_value() == "12"
        assert await page.evaluate("snapshot().title") == first_name

        # A re-imported same-named picture stays in the library until a storyboard
        # import picks the newest take and drops the stale copy.
        await add_material("A10_长衫主顾_四视图.png", "purple")
        await page.locator("#addRef").click()
        same = page.locator("#library").get_by_role(
            "button", name="A10_长衫主顾_四视图.png", exact=True
        )
        await page.wait_for_function(
            "document.querySelectorAll('#library .material-thumb').length===3"
        )
        assert await same.count() == 2, "both takes should be listed"
        await page.locator("#closePicker").click()
        second_name = "S03_重名_6s.TXT"
        await upload(second_name, "文件 A10_长衫主顾_四视图.png <Picture 1>。\n时长：6 秒")
        await page.locator("#formError.success").wait_for()
        message = await page.locator("#formError").inner_text()
        assert "1 条重名旧条目已移除" in message, message
        assert await chips.count() == 1, await chips.all_inner_texts()
        assert await chips.nth(0).inner_text() == "A10_长衫主顾_四视图.png"
        assert await page.locator("#duration").input_value() == "6"
        assert await page.evaluate("snapshot().title") == second_name
        # The stale copy is gone from the library and the picker.
        await page.locator("#addRef").click()
        await page.wait_for_function(
            "document.querySelectorAll('#library .material-thumb').length===2"
        )
        assert await same.count() == 1, "stale copy should be gone"
        await page.locator("#closePicker").click()

        async def mock_comfy(route):
            request = route.request
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
            }
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers=headers)
                return
            path = request.url.removeprefix("http://127.0.0.1:18188")
            if path == "/upload/image":
                response = {"name": "story.png", "type": "input"}
            elif path == "/prompt":
                response = {"prompt_id": request.post_data_json["prompt_id"], "number": 1}
            else:
                response = {"queue_pending": [], "queue_running": []}
            await route.fulfill(json=response, headers=headers)

        await page.route("http://127.0.0.1:18188/**", mock_comfy)
        await page.locator("#server").fill("http://127.0.0.1:18188")
        await page.locator("#server").dispatch_event("change")
        await page.locator("#generate").click()
        task_name = page.locator(".job-name", has_text=second_name)
        await task_name.wait_for(timeout=5000)
        assert await task_name.get_attribute("title") == second_name

        await page.locator("#editor").fill("")
        await page.locator("#editor").fill("手写提示词")
        assert await page.evaluate("snapshot().title") == "手写提示词"
        assert not errors, errors
        await browser.close()
        print("PASS: storyboard TXT preserves its filename, duration and picture bindings")


asyncio.run(main())
