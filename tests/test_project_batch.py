from support import html_path, launch_chromium
import asyncio, io, os, tempfile, wave
from pathlib import Path
from aiohttp import web
from PIL import Image
from playwright.async_api import async_playwright

real_project = os.environ.get("FRAMEFORM_BATCH_PROJECT")
root = Path(__file__).resolve().parent


def wav():
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(8000)
        f.writeframes(bytes(8000))
    return out.getvalue()


async def test(path):
    uploads = []
    posts = []
    queued = []
    history = {}
    allow_uploads = asyncio.Event()

    async def route(req):
        cors = {"Access-Control-Allow-Origin": "*"}
        out = lambda data: web.json_response(data, headers=cors)
        if req.method == "OPTIONS":
            return web.Response(
                headers={
                    **cors,
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                }
            )
        if req.path == "/system_stats":
            return out({"system": {}, "devices": []})
        if req.path == "/queue":
            return out({"queue_running": [], "queue_pending": queued})
        if req.path == "/upload/image":
            await allow_uploads.wait()
            f = (await req.post())["image"]
            uploads.append(f.filename)
            return out({"name": f.filename, "subfolder": "batch-mock", "type": "input"})
        if req.path == "/prompt":
            data = await req.json()
            posts.append(data["prompt"])
            id = data["prompt_id"]
            queued.append(
                [len(posts), id, data["prompt"], {"client_id": data["client_id"]}]
            )
            return out({"prompt_id": id})
        if req.path.startswith("/history/"):
            return out(history)
        return web.Response(status=404, headers=cors)

    app = web.Application()
    app.router.add_route("*", "/{route:.*}", route)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    with tempfile.TemporaryDirectory(dir=root) as temp:
        project = Path(temp) / "测试分镜包"
        for folder in ("assets", "assets/nested", "prompts", "prompts_bak"):
            (project / folder).mkdir(parents=True, exist_ok=True)
        assets = project / "assets"
        prompts = project / "prompts"
        Image.new("RGB", (28, 20), "orange").save(assets / "带 空格的照片.png")
        Image.new("RGB", (28, 20), "navy").save(assets / "另一张.png")
        (assets / "nested" / "片段.mp4").write_bytes(b"mocked video file")
        (assets / "nested" / "夜，片段.mp4").write_bytes(b"mocked night scene")
        (assets / "声音.wav").write_bytes(wav())
        (prompts / "S10_第二条_24s.txt").write_text(
            "镜头见 带 空格的照片.png，见 <Picture 1>。\n镜头保持到本片 24.5 秒处结束。"
        )
        (prompts / "S2_第一条_7s.txt").write_text(
            "<Subject 1> 取景：夜，片段.mp4 <Video 1>、带 空格的照片.png as <picture 1>；声音.wav <Audio 1>。带 空格的照片.png <Picture 1>，再次看向 <Picture 1>。"
        )
        (prompts / "S11_冲突_8s.txt").write_text(
            "时长：9 秒\n本镜取景：不存在_另一张.png，见 <Picture 1>，另一张.png <Picture 2>。"
        )
        (prompts / "S12_错误类型_7s.txt").write_text(
            "时长：7 秒\n 带 空格的照片.png <Video 1>。"
        )
        (prompts / "S13_缺编号_6s.txt").write_text(
            "时长：6 秒\n 另一张.png <Picture 2>。"
        )
        (prompts / "S25_收场_17s.txt").write_text(
            "时长：17 秒\n 带 空格的照片.png <Picture 10>。"
        )
        (project / "prompts_bak" / "不读取_6s.txt").write_text("忽略")
        async with async_playwright() as p:
            b = await launch_chromium(p)
            context = await b.new_context(viewport={"width": 1400, "height": 900})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(path.resolve().as_uri())
            await page.locator("#server").fill(f"http://127.0.0.1:{port}")
            await page.locator("#editor").fill("原有手动草稿")
            await page.locator("#size").select_option(label="1344 × 768")
            await page.locator("#steps").fill("7")
            await page.locator("#openBatch").click()
            assert await page.locator("#batchSteps").input_value() == "6"
            await page.locator("#batchSize").select_option(label="1024 × 576")
            await page.locator("#batchSteps").fill("9")
            if real_project:
                await page.locator("#batchFolder").set_input_files(real_project)
                await page.get_by_text(
                    "共 25 条 · 可提交 24 条 · 已选 0 条 · 跳过 1 条", exact=True
                ).wait_for()
                assert await page.locator("#batchRows tr").count() == 25
                assert (
                    "图片编号 10 超过 9 个槽位"
                    in await page.locator("#batchRows tr").last.inner_text()
                )
                assert "11 秒" in await page.locator("#batchRows tr").first.inner_text()
                assert (
                    "1024 × 576" in await page.locator("#batchProjectName").inner_text()
                )
                assert not uploads and not posts
                print(
                    path.name,
                    "real project preflight: 25 rows, 24 ready, S25 blocked",
                    flush=True,
                )
            await page.set_viewport_size({"width": 390, "height": 844})
            assert await page.evaluate(
                "document.documentElement.scrollWidth===innerWidth"
            )
            await page.set_viewport_size({"width": 1400, "height": 900})
            await page.locator("#batchFolder").set_input_files(project)
            await page.get_by_text(
                "共 6 条 · 可提交 2 条 · 已选 0 条 · 跳过 4 条", exact=True
            ).wait_for()
            assert "S2_第一条" in await page.locator("#batchRows tr").first.inner_text()
            assert await page.get_by_text("素材类型不一致", exact=False).count() == 1
            assert "24.5 秒" in await page.locator("#batchRows tr", has_text="S10_第二条").inner_text()
            assert "assets 中找不到 不存在_另一张.png" in await page.locator("#batchRows tr", has_text="S11_冲突").inner_text()
            # A filename may sit behind a connector ("as"/"，见"); the tag still
            # binds to it and the prompt keeps only the tag.
            joined = await page.evaluate(
                """async () => {
                const read = (body) => ({
                  name: 'S1.txt',
                  webkitRelativePath: 'proj/prompts/S1.txt',
                  text: async () => body,
                });
                const asset = {
                  name: '带 空格的照片.png',
                  webkitRelativePath: 'proj/assets/带 空格的照片.png',
                  text: async () => '',
                };
                const run = async (body) => {
                  const { scenes } = await readBatchProject([read(body), asset], {});
                  return [scenes[0].prompt, scenes[0].errors];
                };
                return {
                  english: await run('Use 带 空格的照片.png as <Picture 1>。\\n时长：7 秒'),
                  chinese: await run('文件 带 空格的照片.png，见 <Picture 1>。\\n时长：7 秒'),
                  missing: await run('见 <Picture 1>。\\n时长：7 秒'),
                };
              }"""
            )
            assert joined["english"] == ["Use <Picture 1>。\n时长：7 秒", []], joined
            assert joined["chinese"] == ["文件 <Picture 1>。\n时长：7 秒", []], joined
            assert joined["missing"][1] == ["找不到 <Picture 1> 对应的素材文件名"], joined
            assert (
                "图片编号 10 超过 9 个槽位"
                in await page.locator("#batchRows tr").last.inner_text()
            )
            assert not uploads
            await page.locator("#batchRatio").select_option("9:16")
            assert "576 × 1024" in await page.locator("#batchProjectName").inner_text()
            assert "9 步" in await page.locator("#batchProjectName").inner_text()
            # Every scene starts unselected; only checked rows may be queued.
            assert await page.locator("#batchRows input[type=checkbox]").count() == 6
            assert (
                await page.locator("#batchRows input[type=checkbox]:checked").count()
                == 0
            )
            assert await page.locator("#batchEnqueue").is_disabled()
            assert (
                await page.locator("#batchRows input[type=checkbox]:disabled").count()
                == 4
            )
            await page.locator("#batchSelectAll").check()
            assert (
                await page.locator("#batchRows input[type=checkbox]:checked").count()
                == 2
            )
            assert await page.get_by_text("已选 2 条", exact=False).count() == 1
            await page.locator("#batchRows tr", has_text="S10_第二条").locator(
                "input[type=checkbox]"
            ).uncheck()
            assert await page.get_by_text("已选 1 条", exact=False).count() == 1
            await page.get_by_role("button", name="将 1 条加入生成队列").click()
            await page.locator(".job").wait_for()
            assert await page.locator(".job").count() == 1
            allow_uploads.set()
            await page.wait_for_function("jobs.length===1 && jobs.every(j=>j.id)")
            assert uploads == ["带 空格的照片.png", "夜，片段.mp4", "声音.wav"], uploads
            assert len(posts) == 1
            assert [d["132"]["inputs"]["value"] for d in posts] == [7]
            for graph in posts:
                assert graph["115"]["inputs"]["megapixels"] == 0.56
                assert (
                    graph["115"]["inputs"]["aspect_ratio"]
                    == "9:16 (Portrait Widescreen)"
                )
                assert len(graph["147"]["inputs"]["sigmas"].split(",")) == 10
            text = posts[0]["138"]["inputs"]["value"]
            assert (
                text
                == "<Subject 1> 取景：<Video 1>、<Picture 1>；<Audio 1>。<Picture 1>，再次看向 <Picture 1>。"
            ), repr(text)
            assert (
                posts[0]["149"]["inputs"]["image"]
                == "batch-mock/带 空格的照片.png"
            )
            assert (
                posts[0][posts[0]["136"]["inputs"]["ref_videos.ref_video_0"][0]][
                    "inputs"
                ]["video"]
                == "batch-mock/夜，片段.mp4"
            )
            assert (
                posts[0][posts[0]["136"]["inputs"]["ref_audios.ref_audio_0"][0]][
                    "inputs"
                ]["audio"]
                == "batch-mock/声音.wav"
            )
            assert await page.locator("#editor").inner_text() == "原有手动草稿"
            # Batch media are filed into a virtual folder named after the project.
            await page.locator("#addRef").click()
            await page.get_by_role("button", name="测试分镜包", exact=True).click()
            assert await page.locator("#library .material-thumb").count() == 3
            await page.locator("#closePicker").click()
            await page.locator(".job-name", has_text="S2_第一条").click()
            assert await page.locator(".job.selected").count() == 1
            assert await page.evaluate("snapshot().prompt") == "原有手动草稿"
            assert await page.locator("#steps").input_value() == "7"
            assert (
                await page.locator("#size option:checked").inner_text() == "1344 × 768"
            )
            await page.reload()
            await page.locator("#openBatch").click()
            assert await page.locator("#batchSteps").input_value() == "9"
            assert await page.locator("#batchRatio").input_value() == "9:16"
            assert (
                await page.locator("#batchSize option:checked").inner_text()
                == "576 × 1024"
            )
            await page.locator("#closeBatch").click()
            assert await page.locator("#steps").input_value() == "7"
            # A second import of the same project reuses the existing folder.
            await page.locator("#openBatch").click()
            await page.locator("#batchFolder").set_input_files(project)
            await page.locator("#batchSelectAll").check()
            await page.locator("#batchRows tr", has_text="S10_第二条").locator(
                "input[type=checkbox]"
            ).uncheck()
            await page.get_by_role("button", name="将 1 条加入生成队列").click()
            await page.wait_for_function("jobs.length===2")
            await page.locator("#addRef").click()
            await page.get_by_role(
                "button", name="测试分镜包", exact=True
            ).wait_for()
            await page.get_by_role(
                "button", name="测试分镜包", exact=True
            ).click()
            await page.wait_for_function(
                "document.querySelectorAll('#library .material-thumb').length===3"
            )
            await page.locator("#closePicker").click()
            # A parent folder works too: the prompts directory is found at any depth.
            await page.locator("#openBatch").click()
            await page.locator("#batchFolder").set_input_files(temp)
            await page.get_by_text("共 6 条 · 可提交 2 条", exact=False).wait_for()
            assert await page.locator("#batchRows tr").count() == 6
            # Two projects under one folder is ambiguous, so ask for one of them.
            other = Path(temp) / "另一包"
            (other / "prompts").mkdir(parents=True)
            (other / "assets").mkdir()
            (other / "prompts" / "S1_另一条_5s.txt").write_text(
                "时长：5 秒\n 带 空格的照片.png <Picture 1>。"
            )
            await page.locator("#batchFolder").set_input_files(temp)
            await page.get_by_text("所选目录中有多个项目", exact=False).wait_for()
            assert "另一包" in await page.locator("#batchError").inner_text()
            # Selecting prompts itself gets a pointer to the parent folder.
            await page.locator("#batchFolder").set_input_files(project / "prompts")
            await page.get_by_text("所选目录是 prompts 本身", exact=False).wait_for()
            await page.locator("#closeBatch").click()
            assert not errors, errors
            await b.close()
    await runner.cleanup()
    print(
        path.name,
        "PASS: actual directory picker, real-project preflight, malformed scenes, mixed tags, shared uploads and draft protection",
    )


asyncio.run(test(html_path()))
