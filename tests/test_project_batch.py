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
        (assets / "声音.wav").write_bytes(wav())
        (prompts / "S10_第二条_9s.txt").write_text(
            "镜头见 带 空格的照片.png <Picture 1>。\n镜头保持到本片 9.00 秒处结束。"
        )
        (prompts / "S2_第一条_7s.txt").write_text(
            "时长：7 秒\n<Subject 1> 见 片段.mp4 <Video 1>、 带 空格的照片.png <picture 1>，听 声音.wav <Audio 1>，再次看向 <Picture 1>。"
        )
        (prompts / "S11_冲突_8s.txt").write_text(
            "时长：9 秒\n 一张不存在.png <Picture 1> 和 另一张.png <Picture 2>。"
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
            await page.locator("#size").select_option(label="1024 × 576")
            await page.locator("#steps").fill("7")
            await page.locator("#openBatch").click()
            if real_project:
                await page.locator("#batchFolder").set_input_files(real_project)
                await page.get_by_text(
                    "共 25 条 · 可提交 24 条 · 跳过 1 条", exact=True
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
                "共 6 条 · 可提交 2 条 · 跳过 4 条", exact=True
            ).wait_for()
            assert "S2_第一条" in await page.locator("#batchRows tr").first.inner_text()
            assert await page.get_by_text("素材类型不一致", exact=False).count() == 1
            assert (
                await page.get_by_text(
                    "正文 9 秒与文件名 8 秒不一致", exact=False
                ).count()
                == 1
            )
            assert (
                "图片编号 10 超过 9 个槽位"
                in await page.locator("#batchRows tr").last.inner_text()
            )
            assert not uploads
            await page.get_by_role("button", name="将 2 条加入生成队列").click()
            await page.wait_for_function("jobs.length===2 && jobs.every(j=>j.id)")
            assert uploads == ["带 空格的照片.png", "片段.mp4", "声音.wav"], uploads
            assert len(posts) == 2
            assert [d["132"]["inputs"]["value"] for d in posts] == [7, 9]
            for graph in posts:
                assert graph["115"]["inputs"]["megapixels"] == 0.56
                assert len(graph["147"]["inputs"]["sigmas"].split(",")) == 8
            text = posts[0]["138"]["inputs"]["value"]
            assert (
                text
                == "时长：7 秒\n<Subject 1> 见 <Video 1>、 <Picture 1>，听 <Audio 1>，再次看向 <Picture 1>。"
            ), repr(text)
            assert (
                posts[0]["149"]["inputs"]["image"]
                == posts[1]["149"]["inputs"]["image"]
                == "batch-mock/带 空格的照片.png"
            )
            assert (
                posts[0][posts[0]["136"]["inputs"]["ref_videos.ref_video_0"][0]][
                    "inputs"
                ]["video"]
                == "batch-mock/片段.mp4"
            )
            assert (
                posts[0][posts[0]["136"]["inputs"]["ref_audios.ref_audio_0"][0]][
                    "inputs"
                ]["audio"]
                == "batch-mock/声音.wav"
            )
            assert await page.locator("#editor").inner_text() == "原有手动草稿"
            await page.locator(".job-name", has_text="S2_第一条").click()
            await page.get_by_text("草稿已保存", exact=True).wait_for()
            assert await page.evaluate("snapshot().prompt") == text
            assert not errors, errors
            await b.close()
    await runner.cleanup()
    print(
        path.name,
        "PASS: actual directory picker, real-project preflight, malformed scenes, mixed tags, shared uploads and queue reuse",
    )


asyncio.run(test(html_path()))
