"""Verify new and saved H3 text-to-video workbenches in the browser."""

import asyncio
import json
import os
from pathlib import Path

from playwright.async_api import async_playwright

from support import ROOT, launch_chromium


def sample():
    def node(type_name, **inputs):
        return {"class_type": type_name, "inputs": inputs}

    return {
        "92": node("SaveVideo", video=["140:130", 0], filename_prefix="video/Test"),
        "115": node(
            "ResolutionSelector",
            aspect_ratio="16:9 (Widescreen)",
            megapixels=0.5,
            multiple=32,
        ),
        "140:122": node("VAEDecode", samples=["140:125", 0]),
        "140:124": node("BasicScheduler", steps=["140:137", 0], denoise=1),
        "140:125": node(
            "SamplerCustomAdvanced", latent_image=["140:131", 1], sigmas=["140:124", 0]
        ),
        "140:130": node("CreateVideo", images=["140:122", 0], fps=24),
        "140:131": node(
            "MiniMaxH3ImageToVideo",
            prompt="测试文生视频的提示词",
            length=["140:132", 1],
            width=["115", 0],
            height=["115", 1],
        ),
        "140:132": node(
            "ComfyMathExpression",
            expression="max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
            **{"values.a": ["140:133", 0]},
        ),
        "140:133": node("PrimitiveFloat", value=26),
        "140:137": node("PrimitiveInt", value=20),
    }


async def verify():
    source = os.environ.get("FRAMEFORM_H3_TEXT_WORKFLOW")
    file = (
        Path(source)
        if source
        else {
            "name": "H3官方文生视频.json",
            "mimeType": "application/json",
            "buffer": json.dumps(sample(), ensure_ascii=False).encode(),
        }
    )
    posted = []
    queue = []
    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright)
        context = await browser.new_context(viewport={"width": 1440, "height": 960})
        page = await context.new_page()
        page.set_default_timeout(8500)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        async def mock(route):
            request = route.request
            name = request.url.rsplit("/", 1)[-1]
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
            }
            if request.method == "OPTIONS":
                await route.fulfill(status=204, headers=headers)
                return
            if name == "system_stats":
                response = {"system": {}, "devices": []}
            elif name == "queue":
                response = {"queue_running": [], "queue_pending": queue}
            elif name == "prompt" and request.method == "POST":
                task = request.post_data_json
                posted.append(task)
                queue.append(
                    [
                        1,
                        task["prompt_id"],
                        task["prompt"],
                        {"client_id": task["client_id"]},
                    ]
                )
                response = {"prompt_id": task["prompt_id"]}
            else:
                response = {}
            await route.fulfill(json=response, headers=headers)

        await context.route("http://127.0.0.1:8188/**", mock)
        await context.route_web_socket(
            "ws://127.0.0.1:8188/**", lambda socket: socket.close()
        )
        await page.goto((ROOT / "dist/Frameform.html").as_uri())
        await page.locator("#workflowImport").click()
        await page.locator("#workflowFile").set_input_files(file)
        await page.wait_for_function(
            "!document.querySelector('#workflowCreate').disabled"
        )
        assert (
            "140:131"
            in await page.locator("#workflowPrompt option:checked").inner_text()
        )
        assert (
            "140:133"
            in await page.locator("#workflowDuration option:checked").inner_text()
        )
        await page.locator("#workflowAdvanced > summary").click()
        await page.locator("#workflowNodeFilter").fill("expression")
        assert await page.locator(
            'input[data-node="140:132"][data-field="expression"]'
        ).is_disabled()
        await page.locator("#workflowCreate").click()
        await page.locator("#workflowDialog").wait_for(state="hidden")
        switch = page.locator("#workflowSelect")
        id = await switch.input_value()
        iframe = page.locator(f'iframe[data-workflow-id="{id}"]')
        workspace = iframe.content_frame
        await workspace.locator("#editor").wait_for()
        assert await workspace.get_by_text("COMFYUI WORKSPACE", exact=True).count() == 0
        assert (
            await workspace.get_by_role(
                "heading", name="视频生成工作台", exact=True
            ).count()
            == 0
        )
        name = workspace.locator("#top .workflow-name")
        assert await name.inner_text() == "H3官方文生视频"
        bounds = await name.bounding_box()
        status = await workspace.locator("#connection").bounding_box()
        assert bounds["x"] + bounds["width"] < status["x"]
        navigation = await workspace.locator("#top").bounding_box()
        server = await workspace.locator(".server").bounding_box()
        assert 0 <= server["y"] - navigation["y"] - navigation["height"] <= 20
        assert await workspace.locator("#editor").inner_text()
        assert await workspace.locator("#duration").input_value() == "26"
        assert await workspace.locator("#steps").input_value() == "20"
        assert await workspace.locator("#openBatch").is_visible()
        assert await workspace.locator("#addRef").is_hidden()
        editor = await workspace.locator("#editor").bounding_box()
        params = await workspace.locator(".params").bounding_box()
        assert editor["x"] + editor["width"] <= params["x"]
        assert editor["width"] > params["width"]

        await workspace.locator("#editor").fill("从提示词区提交")
        await workspace.locator("#duration").fill("11")
        await workspace.locator("#steps").fill("17")
        await workspace.locator("#generate").click()
        await workspace.locator(".job").get_by_text("服务器排队", exact=True).wait_for()
        graph = posted[0]["prompt"]
        assert graph["140:131"]["inputs"]["prompt"] == "从提示词区提交"
        assert graph["140:133"]["inputs"]["value"] == 11
        assert graph["140:137"]["inputs"]["value"] == 17
        assert graph["140:132"]["inputs"]["values.a"] == ["140:133", 0]
        assert not any(key.startswith("ref_") for key in graph["140:131"]["inputs"])

        # Recreate a saved entry from the release that exposed only advanced parameters.
        await page.evaluate(
            """async id => {
          const key = 'workflow-library:' + location.pathname;
          const suffix = id + ':' + location.pathname;
          const advanced = (prompt, duration) => ({
            [JSON.stringify(['140:131','prompt'])]: prompt,
            [JSON.stringify(['140:133','value'])]: duration,
            [JSON.stringify(['140:124','denoise'])]: 0.6
          });
          const form = (prompt, duration) => ({
            html:'', refs:[], advanced:advanced(prompt, duration),
            server:'http://127.0.0.1:8188', ratio:'16:9', mp:0.5, steps:18
          });
          localStorage.setItem('frameform.draft.v1.' + suffix, JSON.stringify(form('旧稿包含 <标签>', 13)));
          localStorage.setItem('frameform.history.v2.' + suffix, JSON.stringify([{
            n:2, base:'http://127.0.0.1:8188', client:'old-job', id:'old-job', sent:true,
            state:'failed', title:'之前的任务', endedAt:2, form:form('旧任务提示词', 8)
          }]));
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('frameform-local', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('files', 'readwrite');
              const store = tx.objectStore('files');
              const workflows = store.get(key);
              workflows.onsuccess = () => {
                const entries = workflows.result;
                const entry = entries.find(item => item.id === id);
                delete entry.mappingVersion;
                delete entry.profile.prompt;
                delete entry.profile.duration;
                entry.profile.advanced = [
                  {field:['140:131','prompt'], kind:'text'},
                  {field:['140:133','value'], kind:'number'},
                  {field:['140:124','denoise'], kind:'number'}
                ];
                store.put(entries, key);
              };
              tx.oncomplete = () => { db.close(); resolve(); };
              tx.onabort = () => { db.close(); reject(tx.error); };
            };
          });
        }""",
            id,
        )
        await page.reload()
        await workspace.get_by_text("草稿已保存", exact=True).wait_for()
        assert await switch.input_value() == id
        assert await switch.locator("option").count() == 2
        assert await workspace.locator("#editor").inner_text() == "旧稿包含 <标签>"
        assert await workspace.locator("#duration").input_value() == "13"
        assert await workspace.locator("#steps").input_value() == "18"
        await workspace.locator("#openAdvanced").click()
        fields = workspace.locator("#advancedFields input, #advancedFields textarea")
        assert await fields.count() == 1
        assert await fields.first.get_attribute("data-field") == "denoise"
        assert await fields.first.input_value() == "0.6"
        await workspace.locator("#advancedCancel").click()
        await workspace.locator(".job-name", has_text="之前的任务").click()
        assert await workspace.locator("#playerPrompt").inner_text() == "旧任务提示词"
        assert "8 秒" in await workspace.locator("#playerParams").inner_text()
        assert await workspace.locator("#editor").inner_text() == "旧稿包含 <标签>"
        await workspace.locator("#reuse").click()
        await workspace.get_by_text("草稿已保存", exact=True).wait_for()
        assert await workspace.locator("#editor").inner_text() == "旧任务提示词"
        assert await workspace.locator("#duration").input_value() == "8"

        await workspace.locator("#editor").fill("")
        await page.reload()
        await workspace.get_by_text("草稿已保存", exact=True).wait_for()
        assert (await workspace.locator("#editor").inner_text()).strip() == ""
        for width in (390, 320):
            await page.set_viewport_size({"width": width, "height": 844})
            assert await workspace.locator("#editor").is_visible()
            assert await workspace.locator("#duration").is_visible()
            assert await name.is_visible()
            assert await workspace.locator("body").evaluate(
                "(body) => body.scrollWidth <= innerWidth"
            )
        assert not errors, errors
        await browser.close()

    print(
        "PASS: H3 text-to-video mapping, layout, submission and saved-workflow repair."
    )


asyncio.run(verify())
