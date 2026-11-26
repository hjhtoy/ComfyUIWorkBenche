"""Exercise the HyperFlow import, saved-library upgrade and submitted API graph."""

import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.async_api import async_playwright

from support import ROOT, launch_chromium


def example():
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    return {
        "5": node("MiniMaxH3ReferenceToVideo", width=1344, height=768, length=124, prompt=""),
        "6": node("HyperFlowSigmas", steps=6),
        "10": node("SamplerCustomAdvanced", latent_image=["5", 1], sigmas=["6", 0]),
        "11": node("VAEDecode", samples=["10", 0]),
        "13": node("CreateVideo", images=["11", 0], fps=24),
        "14": node("SaveVideo", video=["13", 0], filename_prefix="test"),
    }


async def verify():
    source = os.environ.get("FRAMEFORM_HYPERFLOW_WORKFLOW")
    graph = json.loads(Path(source).read_text(encoding="utf-8-sig")) if source else example()
    posted = []
    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright)
        page = await browser.new_page()
        page.set_default_timeout(8000)

        async def mock(route):
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
            }
            if route.request.method == "OPTIONS":
                await route.fulfill(status=204, headers=headers)
                return
            endpoint = route.request.url.rsplit("/", 1)[-1]
            if endpoint == "prompt":
                task = route.request.post_data_json
                posted.append(task["prompt"])
                response = {"prompt_id": task["prompt_id"]}
            elif endpoint == "system_stats":
                response = {"system": {}, "devices": []}
            else:
                response = {"queue_running": [], "queue_pending": []}
            await route.fulfill(json=response, headers=headers)

        await page.route("http://127.0.0.1:8188/**", mock)
        await page.route_web_socket("ws://127.0.0.1:8188/**", lambda socket: socket.close())
        await page.goto((ROOT / "dist/Frameform.html").as_uri())
        await page.locator("#workflowImport").click()
        await page.locator("#workflowFile").set_input_files({
            "name": "HyperFlow.json",
            "mimeType": "application/json",
            "buffer": json.dumps(graph).encode(),
        })
        await page.locator("#workflowCreate").click()
        await page.locator("#workflowDialog").wait_for(state="hidden")
        workflow_id = await page.locator("#workflowSelect").input_value()
        frame = page.frame_locator(f'iframe[data-workflow-id="{workflow_id}"]')
        size, duration, steps = (frame.locator("#" + key) for key in ("size", "duration", "steps"))
        for control in (size, duration, steps):
            await control.wait_for()
        assert await size.locator("option:checked").inner_text() == "1344 × 768"
        assert await duration.input_value() == "124"
        assert await duration.get_attribute("step") == "17"
        assert "5.17 秒" in await frame.locator("#timing").inner_text()
        assert await steps.input_value() == "6"
        assert [await steps.get_attribute(key) for key in ("min", "max", "step")] == ["4", "8", "2"]
        await frame.locator("#editor").fill("测试分镜")
        async with page.expect_request("**/prompt"):
            await frame.locator("#generate").click()
        await frame.get_by_text("服务器排队", exact=True).first.wait_for()
        assert posted[0]["5"]["inputs"]["length"] == 124
        assert posted[0]["6"]["inputs"]["steps"] == 6

        # Existing entries from version 1 have no picture bindings at all.
        await page.evaluate("""async id => {
          const db = await new Promise(resolve => {
            const request = indexedDB.open('frameform-local', 1);
            request.onsuccess = () => resolve(request.result);
          });
          const tx = db.transaction('files', 'readwrite');
          const store = tx.objectStore('files');
          const key = 'workflow-library:' + location.pathname;
          const read = store.get(key);
          read.onsuccess = () => {
            const entry = read.result.find(item => item.id === id);
            entry.mappingVersion = 1;
            for (const field of ['size', 'steps', 'duration']) delete entry.profile[field];
            store.put(read.result, key);
          };
          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
          });
          db.close();
        }""", workflow_id)
        await page.reload()
        await frame.get_by_text("草稿已保存", exact=True).wait_for()
        assert await page.locator("#workflowSelect").input_value() == workflow_id
        await size.select_option(label="768 × 1344")
        await duration.fill("141")
        await steps.fill("8")
        await page.reload()
        await frame.get_by_text("草稿已保存", exact=True).wait_for()
        assert await duration.input_value() == "141"
        assert await steps.input_value() == "8"
        async with page.expect_response("**/prompt"):
            await frame.locator("#generate").click()
        inputs = posted[-1]["5"]["inputs"]
        assert (inputs["width"], inputs["height"], inputs["length"]) == (768, 1344, 141)
        assert posted[-1]["6"]["inputs"]["steps"] == 8
        assert posted[-1]["10"]["inputs"]["sigmas"] == ["6", 0]
        with TemporaryDirectory() as temp:
            prompts = Path(temp) / "prompts"
            prompts.mkdir()
            (prompts / "片段_24s.txt").write_text("批量测试\n时长：24.5 秒", encoding="utf-8")
            await frame.locator("#openBatch").click()
            await frame.locator("#batchSteps").fill("4")
            await frame.locator("#batchFolder").set_input_files(temp)
            await frame.locator("#batchSelectAll").check()
            async with page.expect_response("**/prompt"):
                await frame.locator("#batchEnqueue").click()
            assert posted[-1]["5"]["inputs"]["length"] == 600
            assert posted[-1]["6"]["inputs"]["steps"] == 4
        await browser.close()


asyncio.run(verify())
