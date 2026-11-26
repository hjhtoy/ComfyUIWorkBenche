"""Exercise the unified workbench against a local mock ComfyUI API."""

import asyncio
from copy import deepcopy
import io
import json
import os
from tempfile import TemporaryDirectory
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

from support import ROOT, launch_chromium


OFFICIAL = "H3官方参考生视频.json"
QWEN = "qwen_img2_1文生图.json"
PIKA = "Pika H3 Flex 加速.json"
TEST_SERVER = "http://127.0.0.1:8188"


def default_samples():
    graph = json.loads((ROOT / "workflows/pika-h3.api.json").read_text())
    official = deepcopy(graph)
    official.pop("147")
    official.pop("152")
    official["92"] = {
        "class_type": "SaveVideo",
        "inputs": {
            "filename_prefix": "video/Test",
            "video": ["130", 0],
            "format": "auto",
        },
    }
    official["130"] = {
        "class_type": "CreateVideo",
        "inputs": {"fps": 24, "images": ["122", 0], "audio": ["121", 0]},
    }
    official["124"] = {
        "class_type": "BasicScheduler",
        "inputs": {"steps": ["142", 0], "denoise": 1},
    }
    official["142"] = {
        "class_type": "ComfySwitchNode",
        "inputs": {"switch": ["146", 0], "on_false": ["143", 0], "on_true": ["144", 0]},
    }
    for id, type_name, value in (
        ("143", "PrimitiveInt", 20),
        ("144", "PrimitiveInt", 4),
        ("146", "PrimitiveBoolean", False),
    ):
        official[id] = {"class_type": type_name, "inputs": {"value": value}}
    official["125"]["inputs"]["sigmas"] = ["124", 0]
    official["132"]["inputs"]["value"] = 5
    qwen = {
        "461": {
            "class_type": "SaveImageAdvanced",
            "inputs": {"images": ["459:457", 0]},
        },
        "459:457": {"class_type": "VAEDecode", "inputs": {"samples": ["459:458", 0]}},
        "459:458": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 77,
                "steps": 25,
                "positive": ["459:452", 0],
                "negative": ["459:452", 1],
                "latent_image": ["459:456", 0],
            },
        },
        "459:452": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {"prompt": ["459:472", 0], "negative_prompt": "保持原样"},
        },
        "459:472": {"class_type": "PreviewAny", "inputs": {"source": ["459:474", 0]}},
        "459:474": {
            "class_type": "ComfySwitchNode",
            "inputs": {
                "switch": False,
                "on_false": "</script><script>window.injected=1</script>",
                "on_true": ["459:471", 0],
            },
        },
        "459:471": {"class_type": "TextGenerate", "inputs": {"prompt": "备用提示词"}},
        "459:456": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": ["13", 0], "height": ["13", 1]},
        },
        "13": {
            "class_type": "ResolutionSelector",
            "inputs": {"aspect_ratio": "1:1 (Square)", "megapixels": 1, "multiple": 8},
        },
    }
    return {OFFICIAL: official, QWEN: qwen, PIKA: graph}


async def verify():
    samples_dir = os.environ.get("FRAMEFORM_WORKFLOW_SAMPLES")
    if samples_dir:
        files = {name: Path(samples_dir) / name for name in (OFFICIAL, QWEN, PIKA)}
        originals = {
            name: json.loads(file.read_text(encoding="utf-8-sig"))
            for name, file in files.items()
        }
    else:
        originals = default_samples()
        files = {
            name: {
                "name": name,
                "mimeType": "application/json",
                "buffer": json.dumps(graph).encode(),
            }
            for name, graph in originals.items()
        }

    posted, uploads = [], []
    running, history = {}, {}
    still = io.BytesIO()
    Image.new("RGB", (24, 16), "coral").save(still, "PNG")
    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright)
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        page = await context.new_page()
        page.set_default_timeout(8500)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        async def mock(route):
            request = route.request
            path = request.url.removeprefix(TEST_SERVER).removeprefix("/studio")
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
            elif path == "/object_info":
                data = {
                    node["class_type"]: {}
                    for graph in originals.values()
                    for node in graph.get("prompt", graph).values()
                }
                data["BasicScheduler"] = {
                    "input": {
                        "required": {
                            "denoise": ["FLOAT", {"min": 0, "max": 1, "step": 0.01}],
                        }
                    }
                }
                data["SaveVideo"] = {
                    "input": {"required": {"format": [["auto", "mp4"]]}}
                }
            elif path == "/upload/image":
                uploads.append(request.post_data_buffer)
                data = {"name": "reference.png", "subfolder": "mock"}
            elif path == "/prompt":
                task = request.post_data_json
                posted.append(task)
                id = task["prompt_id"]
                running[id] = [
                    1,
                    id,
                    task["prompt"],
                    {
                        **task.get("extra_data", {}),
                        "client_id": task["client_id"],
                    },
                ]
                data = {"prompt_id": id}
            elif path == "/queue":
                data = {"queue_running": list(running.values()), "queue_pending": []}
            elif path.startswith("/history/"):
                id = path.rsplit("/", 1)[1]
                data = {id: history[id]} if id in history else {}
            elif path.startswith("/view?"):
                await route.fulfill(
                    body=still.getvalue(), content_type="image/png", headers=cors
                )
                return
            else:
                await route.fulfill(status=404, headers=cors)
                return
            await route.fulfill(json=data, headers=cors)

        await context.route(TEST_SERVER + "/**", mock)
        await context.route_web_socket(
            "ws://127.0.0.1:8188/**", lambda socket: socket.close()
        )
        await page.goto((ROOT / "dist/Frameform.html").as_uri())
        switch = page.locator("#workflowSelect")
        assert await switch.locator("option").count() == 1
        await page.locator("#server").fill(TEST_SERVER + "/studio")
        await page.locator("#editor").fill("Pika 独立草稿")

        async def import_workflow(name):
            await page.locator("#workflowImport").click()
            await page.locator("#workflowFile").set_input_files(files[name])
            await page.locator("#workflowCreate").wait_for()
            await page.wait_for_function(
                "!document.querySelector('#workflowCreate').disabled"
            )

        async def create():
            await page.locator("#workflowCreate").click()
            await page.locator("#workflowDialog").wait_for(state="hidden")
            id = await switch.input_value()
            assert id
            return id

        def frame(id):
            return page.frame_locator(f'iframe[data-workflow-id="{id}"]')

        await page.locator("#workflowImport").click()
        await page.locator("#workflowFile").set_input_files(
            {
                "name": "editor.json",
                "mimeType": "application/json",
                "buffer": b'{"nodes":[]}',
            }
        )
        await page.get_by_text("这是 ComfyUI 编辑器格式。", exact=False).wait_for()
        assert await page.locator("#workflowCreate").is_disabled()
        await page.locator("#workflowCancel").click()

        await import_workflow(OFFICIAL)
        assert (
            "SaveVideo"
            in await page.locator("#workflowOutput option:checked").text_content()
        )
        assert (
            "143 · PrimitiveInt · value"
            in await page.locator("#workflowSteps option:checked").text_content()
        )
        assert (
            "秒转帧"
            in await page.locator("#workflowDuration option:checked").text_content()
        )
        assert await page.locator("#workflowRefCount").inner_text() == "9 个连接槽位"
        await page.locator("#workflowCheckNodes").click()
        await page.get_by_text("服务器已提供全部", exact=False).wait_for()
        await page.locator("#workflowAdvanced > summary").click()
        node_filter = page.locator("#workflowNodeFilter")
        for node, field in [
            ("124", "denoise"),
            ("129", "noise_seed"),
            ("92", "format"),
        ]:
            await node_filter.fill(field)
            await page.locator(
                f'input[data-node="{node}"][data-field="{field}"]'
            ).check()
        assert await page.locator("#workflowAdvancedCount").inner_text() == "3 项已选"
        await node_filter.fill("value")
        assert await page.locator(
            'input[data-node="143"][data-field="value"]'
        ).is_disabled()
        assert await page.locator(
            'input[data-node="146"][data-field="value"]'
        ).is_disabled()
        official = await create()
        video = frame(official)

        def parameter(frame_locator, node, field):
            return frame_locator.locator(
                f'#advancedFields [data-node="{node}"][data-field="{field}"]'
            )

        await video.locator("#openAdvanced").click()
        await parameter(video, "124", "denoise").fill("1.1")
        await video.locator("#advancedSave").click()
        assert "denoise 的值无效" in await video.locator("#advancedError").inner_text()
        await parameter(video, "124", "denoise").fill("0.55")
        await parameter(video, "129", "noise_seed").fill("123")
        await parameter(video, "92", "format").select_option(label="mp4")
        await video.locator("#advancedSave").click()
        assert await video.locator("#server").input_value() == TEST_SERVER + "/studio"
        await video.locator("#editor").fill("官方 H3 草稿 ")
        await video.locator("#editor").press("End")
        await page.keyboard.insert_text("@")
        await video.locator("#file").set_input_files(
            {
                "name": "reference.png",
                "mimeType": "image/png",
                "buffer": still.getvalue(),
            }
        )
        await video.get_by_role("button", name="reference.png", exact=True).click()
        await video.locator("#editor .mention").wait_for()
        await video.locator("#steps").fill("12")
        await video.locator("#duration").fill("9")
        await video.locator("#generate").click()
        await video.locator(".job").get_by_text("生成中", exact=True).wait_for()
        assert len(posted) == 1 and uploads
        official_task = posted[0]
        graph = official_task["prompt"]
        assert official_task["extra_data"]["frameform_workflow_id"] == official
        assert graph["143"]["inputs"]["value"] == 12
        assert graph["144"]["inputs"]["value"] == 4
        assert graph["132"]["inputs"]["value"] == 9
        assert graph["124"]["inputs"]["denoise"] == 0.55
        assert graph["129"]["inputs"]["noise_seed"] == 123
        assert graph["92"]["inputs"]["format"] == "mp4"
        assert graph["138"]["inputs"]["value"].endswith("<Picture 1>")
        assert graph["136"]["inputs"]["ref_images.ref_image_0"][0] in graph

        await import_workflow(QWEN)
        assert (
            "SaveImageAdvanced"
            in await page.locator("#workflowOutput option:checked").text_content()
        )
        assert (
            "459:474 · ComfySwitchNode · on_false"
            in await page.locator("#workflowPrompt option:checked").text_content()
        )
        await page.locator("#workflowCheckNodes").click()
        await page.get_by_text("服务器已提供全部", exact=False).wait_for()
        qwen = await create()
        image = frame(qwen)
        await image.locator("#editor").wait_for()
        assert not await image.locator("#editor").evaluate("() => window.injected")
        assert await image.locator("#duration").is_hidden()
        assert await image.locator("#openBatch").is_hidden()
        assert await image.locator("#addRef").is_hidden()
        await image.locator("#editor").fill("Qwen 独立草稿")
        await image.locator("#steps").fill("18")
        await image.locator("#generate").click()
        await image.locator(".job").get_by_text("生成中", exact=True).wait_for()
        assert len(posted) == 2
        image_task = posted[1]
        updated = image_task["prompt"]
        original = originals[QWEN].get("prompt", originals[QWEN])
        assert image_task["extra_data"]["frameform_workflow_id"] == qwen
        assert updated["459:474"]["inputs"]["on_false"] == "Qwen 独立草稿"
        assert updated["459:458"]["inputs"]["steps"] == 18
        assert updated["459:471"] == original["459:471"]
        assert updated["459:452"] == original["459:452"]
        assert await image.locator(".job").count() == 1

        def complete(task, outputs):
            id = task["prompt_id"]
            running.pop(id)
            history[id] = {
                "status": {"completed": True, "status_str": "success"},
                "outputs": outputs,
            }

        complete(
            official_task,
            {"92": {"videos": [{"filename": "h3.mp4", "type": "output"}]}},
        )
        complete(
            image_task,
            {
                "extra-output": {
                    "videos": [{"filename": "unselected.mp4", "type": "output"}]
                },
                "461": {"images": [{"filename": "qwen.png", "type": "output"}]},
            },
        )
        await image.locator(".job").get_by_text("已完成", exact=True).wait_for()
        # Check the completed job while its iframe remains hidden.
        await page.wait_for_function(
            """id => document.querySelector('[data-workflow-id="'+id+'"]').contentDocument
            .querySelector('.job .state')?.textContent === '已完成'""",
            arg=official,
        )
        await image.locator(".job-cover").click()
        await image.locator("#playerStage img").wait_for()
        await image.locator("#closePlayer").click()

        await import_workflow(PIKA)
        await page.get_by_text("与内置的 Pika H3 Flex 相同", exact=False).wait_for()
        assert await create() == "pika-h3"
        assert await page.locator("#editor").inner_text() == "Pika 独立草稿"
        assert await switch.locator("option").count() == 3
        await page.locator("#steps").fill("7")
        await page.locator("#generate").click()
        await (
            page.locator("#builtinWorkbench .job")
            .get_by_text("生成中", exact=True)
            .wait_for()
        )
        assert len(posted[2]["prompt"]["147"]["inputs"]["sigmas"].split(",")) == 8
        assert posted[2]["extra_data"]["frameform_workflow_id"] == "pika-h3"

        await switch.select_option(official)
        await video.locator("#generate").click()
        await video.locator(".job").first.get_by_text("生成中", exact=True).wait_for()
        resumed = posted[-1]
        await switch.select_option(qwen)
        await page.reload()
        await page.wait_for_function(
            "id => document.querySelector('#workflowSelect').value === id", arg=qwen
        )
        assert await image.locator("#editor").inner_text() == "Qwen 独立草稿"
        assert await image.locator("#steps").input_value() == "18"
        assert (
            await image.locator(".job").get_by_text("已完成", exact=True).count() == 1
        )
        await page.wait_for_function(
            """id => document.querySelector('[data-workflow-id="'+id+'"]')?.hidden &&
            document.querySelector('[data-workflow-id="'+id+'"]').contentDocument
            ?.querySelector('.job .state')?.textContent === '生成中'""",
            arg=official,
        )
        complete(
            resumed,
            {"92": {"videos": [{"filename": "h3-resumed.mp4", "type": "output"}]}},
        )
        await page.wait_for_function(
            """id => document.querySelector('[data-workflow-id="'+id+'"]').contentDocument
            .querySelector('.job .state')?.textContent === '已完成'""",
            arg=official,
        )
        await switch.select_option(official)
        await video.get_by_text("草稿已保存", exact=True).wait_for()
        assert "官方 H3 草稿" in await video.locator("#editor").inner_text()
        assert await video.locator("#editor .mention").inner_text() == "reference.png"
        assert await video.locator("#duration").input_value() == "9"
        assert (
            await video.locator(".job").get_by_text("已完成", exact=True).count() == 2
        )
        await video.locator("#openAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "0.55"
        await video.locator("#advancedCancel").click()

        await video.locator("#openBatch").click()
        await video.locator("#batchAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "1"
        await parameter(video, "124", "denoise").fill("0.7")
        await parameter(video, "129", "noise_seed").fill("777")
        await video.locator("#advancedSave").click()
        assert await video.locator("#batchDialog").is_visible()
        await video.locator("#batchRatio").select_option("9:16")
        await video.locator("#batchSteps").fill("8")
        with TemporaryDirectory() as directory:
            project = Path(directory) / "batch"
            (project / "prompts").mkdir(parents=True)
            (project / "assets").mkdir()
            (project / "prompts" / "S1_批量测试_7s.txt").write_text(
                "时长：7 秒\n批量测试。"
            )
            await video.locator("#batchFolder").set_input_files(project)
            await video.locator("#batchSelectAll").check()
            await video.locator("#batchEnqueue").click()
            batch_row = video.locator(".job", has_text="S1_批量测试")
            await batch_row.get_by_text("生成中", exact=True).wait_for()
        batch_task = posted[-1]
        batch_graph = batch_task["prompt"]
        assert batch_graph["124"]["inputs"]["denoise"] == 0.7
        assert batch_graph["129"]["inputs"]["noise_seed"] == 777
        assert batch_graph["92"]["inputs"]["format"] == "auto"
        assert batch_graph["143"]["inputs"]["value"] == 8
        assert (
            batch_graph["115"]["inputs"]["aspect_ratio"] == "9:16 (Portrait Widescreen)"
        )
        assert batch_graph["132"]["inputs"]["value"] == 7

        await video.locator("#openAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "0.55"
        await video.locator("#advancedCancel").click()
        complete(
            batch_task,
            {"92": {"videos": [{"filename": "batch.mp4", "type": "output"}]}},
        )
        await video.get_by_role("tab", name="全部").click()
        await batch_row.get_by_text("已完成", exact=True).wait_for()
        await batch_row.locator(".job-name").click()
        await video.locator("#playerAdvanced").get_by_text("0.7", exact=True).wait_for()
        assert await video.locator("#steps").input_value() == "12"
        await video.locator("#reuse").click()
        await video.get_by_text("草稿已保存", exact=True).wait_for()
        await video.locator("#openAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "0.7"
        await video.locator("#advancedReset").click()
        assert await parameter(video, "124", "denoise").input_value() == "1"
        await video.locator("#advancedCancel").click()
        await video.locator("#openAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "0.7"
        await video.locator("#advancedCancel").click()

        await import_workflow(PIKA)
        await page.locator("#workflowAdvanced > summary").click()
        await page.locator("#workflowNodeFilter").fill("noise_seed")
        await page.locator('input[data-node="129"][data-field="noise_seed"]').check()
        custom_pika = await create()
        assert custom_pika != "pika-h3"
        await frame(custom_pika).locator("#openAdvanced").wait_for()
        assert await switch.locator("option").count() == 4
        await switch.select_option(official)
        await page.reload()
        await video.locator("#openBatch").click()
        assert await video.locator("#batchSteps").input_value() == "8"
        await video.locator("#batchAdvanced").click()
        assert await parameter(video, "124", "denoise").input_value() == "0.7"
        await video.locator("#advancedCancel").click()
        await video.locator("#closeBatch").click()

        await page.set_viewport_size({"width": 390, "height": 844})
        assert await page.evaluate(
            "document.documentElement.scrollWidth === innerWidth"
        )
        await page.locator("#workflowImport").click()
        assert await page.locator("#workflowFile").is_visible()
        await page.locator("#workflowCancel").click()

        remove = page.locator("#workflowRemove")
        await switch.select_option(qwen)
        await image.locator("#generate").click()
        await image.locator(".job").first.get_by_text("生成中", exact=True).wait_for()
        active_image = posted[-1]
        await remove.click()
        assert (
            "qwen_img2_1文生图"
            in await page.locator("#removeWorkflowMessage").inner_text()
        )
        await page.locator("#cancelRemoveWorkflow").click()
        assert await switch.input_value() == qwen
        assert await switch.locator("option").count() == 4
        await remove.click()
        await page.locator("#confirmRemoveWorkflow").click()
        await page.locator("#removeWorkflowDialog").wait_for(state="hidden")
        assert await switch.input_value() == "pika-h3"
        assert await remove.is_disabled()
        assert await switch.locator(f'option[value="{qwen}"]').count() == 0
        assert active_image["prompt_id"] in running

        await page.reload()
        await page.wait_for_function(
            "document.querySelector('#workflowSelect').options.length === 3"
        )
        assert await switch.input_value() == "pika-h3"
        assert await switch.locator(f'option[value="{qwen}"]').count() == 0
        await page.wait_for_function(
            """id => {
              const workspace = document.querySelector('[data-workflow-id="'+id+'"]');
              return workspace?.hidden && workspace.contentDocument
                .querySelector('.job .state')?.textContent === '生成中';
            }""",
            arg=qwen,
        )
        complete(
            active_image,
            {
                "461": {
                    "images": [{"filename": "qwen-after-remove.png", "type": "output"}]
                }
            },
        )
        await import_workflow(QWEN)
        assert await create() == qwen
        assert await image.locator("#editor").inner_text() == "Qwen 独立草稿"
        await image.locator(".job").first.get_by_text("已完成", exact=True).wait_for()
        assert await switch.locator("option").count() == 4
        assert not errors, errors
        await browser.close()
    print(
        "PASS: imports, mapping, three graphs, separate jobs/drafts, background progress, advanced node overrides, independent batch settings, removal and recovery, reload and mobile."
    )


asyncio.run(verify())
