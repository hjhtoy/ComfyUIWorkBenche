"""Prompt fields behind text-generation chains must map to the text a person edits."""
import asyncio
import io
import json
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

from support import ROOT, launch_chromium

SERVER = "http://127.0.0.1:8188"
FIXTURES = ROOT / "tests" / "fixtures"
TEXT_PROMPT = "云海中的白色灯塔，清晨薄雾"
EDIT_PROMPT = "把背景换成雪后的松林"
PAIR_PROMPT = "把图2的人物替换到图1中，保持姿势和色调"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8-sig"))


async def verify():
    graphs = {
        "text": load("h3-image-text.api.json"),
        "edit": load("h3-image-edit.api.json"),
        "pair": load("h3-reference-edit.api.json"),
    }
    still = io.BytesIO()
    Image.new("RGB", (24, 16), "teal").save(still, "PNG")
    still2 = io.BytesIO()
    Image.new("RGB", (20, 12), "navy").save(still2, "PNG")
    posted = []

    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright)
        context = await browser.new_context(viewport={"width": 1400, "height": 950})
        page = await context.new_page()
        page.set_default_timeout(9000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        async def mock(route):
            request = route.request
            path = request.url.removeprefix(SERVER)
            cors = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
            }
            if request.method == "OPTIONS":
                await route.fulfill(
                    status=204,
                    headers={
                        **cors,
                        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    },
                )
                return
            if path == "/system_stats":
                data = {"system": {}, "devices": []}
            elif path == "/upload/image":
                data = {"name": "reference.png", "subfolder": "mock"}
            elif path == "/prompt":
                posted.append(request.post_data_json)
                data = {"prompt_id": request.post_data_json["prompt_id"]}
            elif path == "/queue":
                data = {"queue_running": [], "queue_pending": []}
            elif path.startswith("/history"):
                data = {}
            elif path.startswith("/view?"):
                await route.fulfill(
                    body=still.getvalue(), content_type="image/png", headers=cors
                )
                return
            else:
                data = {}
            await route.fulfill(json=data, headers=cors)

        await context.route(SERVER + "/**", mock)
        await context.route_web_socket(
            "ws://127.0.0.1:8188/**", lambda socket: socket.close()
        )
        await page.goto((ROOT / "dist" / "Frameform.html").as_uri())
        await page.locator("#server").fill(SERVER)

        async def import_graph(name, graph, prompt_value):
            await page.locator("#workflowImport").click()
            await page.locator("#workflowFile").set_input_files(
                {
                    "name": name,
                    "mimeType": "application/json",
                    "buffer": json.dumps(graph, ensure_ascii=False).encode(),
                }
            )
            await page.locator("#workflowCreate").wait_for()
            await page.wait_for_function(
                "!document.querySelector('#workflowCreate').disabled"
            )
            # The user prompt node must be selected automatically, not the
            # system template or the replacement placeholder.
            assert (
                await page.locator("#workflowPrompt").input_value() == prompt_value
            ), await page.locator("#workflowPrompt").input_value()
            await page.locator("#workflowCreate").click()
            await page.locator("#workflowDialog").wait_for(state="hidden")
            id = await page.locator("#workflowSelect").input_value()
            assert id
            return page.frame_locator(f'iframe[data-workflow-id="{id}"]')

        async def wait_posted(count):
            for _ in range(80):
                if len(posted) >= count:
                    return
                await asyncio.sleep(0.1)
            raise AssertionError("the browser did not submit a prompt")

        text_frame = await import_graph(
            "H3_文生图.json", graphs["text"], '["43","value"]'
        )
        await text_frame.locator("#promptRegion").wait_for(state="visible")
        default = graphs["text"]["43"]["inputs"]["value"].strip()
        assert default[:20] in await text_frame.locator("#editor").inner_text()
        await text_frame.locator("#editor").fill(TEXT_PROMPT)
        await text_frame.locator("#generate").click()
        await wait_posted(1)
        sent = posted[0]["prompt"]
        assert sent["43"]["inputs"]["value"] == TEXT_PROMPT, sent["43"]["inputs"]["value"]
        assert sent["40"]["inputs"]["find"] == "{input text}"
        assert sent["39"]["inputs"]["value"] == graphs["text"]["39"]["inputs"]["value"]
        assert sent["36"]["inputs"]["value"] == graphs["text"]["36"]["inputs"]["value"]

        edit_frame = await import_graph(
            "H3_修图.json", graphs["edit"], '["43","value"]'
        )
        await edit_frame.locator("#promptRegion").wait_for(state="visible")
        await edit_frame.locator("#addRef").click()
        await edit_frame.locator("#file").set_input_files(
            {"name": "reference.png", "mimeType": "image/png", "buffer": still.getvalue()}
        )
        await edit_frame.get_by_role("button", name="reference.png", exact=True).wait_for()
        await edit_frame.locator("#closePicker").click()
        await edit_frame.locator("#editor").fill(EDIT_PROMPT)
        await edit_frame.locator("#editor").press("End")
        await page.keyboard.insert_text("@")
        await edit_frame.get_by_role("button", name="reference.png", exact=True).click()
        await edit_frame.locator("#generate").click()
        await wait_posted(2)
        sent = posted[1]["prompt"]
        assert sent["43"]["inputs"]["value"].startswith(EDIT_PROMPT), sent["43"]["inputs"]["value"]
        assert sent["40"]["inputs"]["find"] == "{input text}"
        assert sent["39"]["inputs"]["value"] == graphs["edit"]["39"]["inputs"]["value"]

        # Reference-to-video graph used for image editing: the user text enters
        # through CR Text Replace, and steps sit behind ExtendIntermediateSigmas.
        pair_frame = await import_graph(
            "H3_图片编辑_双参考.json", graphs["pair"], '["160","text"]'
        )
        await pair_frame.locator("#promptRegion").wait_for(state="visible")
        # A default without material tags is safe to prefill, even with slots.
        pair_default = graphs["pair"]["160"]["inputs"]["text"].strip()
        assert pair_default[:16] in await pair_frame.locator("#editor").inner_text()
        assert await pair_frame.locator("#steps").input_value() == "8"
        await pair_frame.locator("#addRef").click()
        await pair_frame.locator("#file").set_input_files(
            {"name": "ref1.png", "mimeType": "image/png", "buffer": still.getvalue()}
        )
        await pair_frame.get_by_role("button", name="ref1.png", exact=True).wait_for()
        await pair_frame.locator("#file").set_input_files(
            {"name": "ref2.png", "mimeType": "image/png", "buffer": still2.getvalue()}
        )
        await pair_frame.get_by_role("button", name="ref2.png", exact=True).wait_for()
        await pair_frame.locator("#closePicker").click()
        # Insert both references first, then type the instruction after them.
        await pair_frame.locator("#editor").click()
        await pair_frame.locator("#editor").press("End")
        await page.keyboard.insert_text("@")
        await pair_frame.get_by_role("button", name="ref1.png", exact=True).click()
        await pair_frame.locator("#editor").press("End")
        await page.keyboard.insert_text("@")
        await pair_frame.get_by_role("button", name="ref2.png", exact=True).click()
        await pair_frame.locator("#editor").press("End")
        await page.keyboard.insert_text(PAIR_PROMPT)
        await pair_frame.locator("#steps").fill("12")
        await pair_frame.locator("#generate").click()
        await wait_posted(3)
        sent = posted[2]["prompt"]
        assert PAIR_PROMPT in sent["160"]["inputs"]["text"], sent["160"]
        assert sent["241"]["inputs"]["text"] == graphs["pair"]["241"]["inputs"]["text"]
        assert sent["14"]["inputs"]["steps"] == 12, sent["14"]["inputs"]["steps"]
        assert sent["40"]["inputs"]["image"] and sent["41"]["inputs"]["image"]
        assert not errors, errors
        await browser.close()


asyncio.run(verify())
print(
    "PASS: text-generation prompt chains map the editable user text for both "
    "text-to-image and image-edit workflows"
)
