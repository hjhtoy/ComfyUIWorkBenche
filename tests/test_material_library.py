from support import html_path, launch_chromium
import asyncio, base64, io, wave
from aiohttp import web
from PIL import Image
from playwright.async_api import async_playwright


def audio(offset):
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(8000)
        f.writeframes(bytes([offset, 0]) * 1200)
    return out.getvalue()


async def verify(path):
    uploads = []
    pending = []
    graphs = []
    history = {}
    media = {}
    img = io.BytesIO()
    Image.new("RGB", (21, 14), "orange").save(img, format="PNG")
    png = img.getvalue()

    async def route(req):
        out = lambda data: web.json_response(
            data, headers={"Access-Control-Allow-Origin": "*"}
        )
        if req.method == "OPTIONS":
            return web.Response(
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                }
            )
        if req.path == "/system_stats":
            return out({"system": {}, "devices": []})
        if req.path == "/queue":
            return out({"queue_running": [], "queue_pending": pending})
        if req.path == "/upload/image":
            f = (await req.post())["image"]
            uploads.append(f.filename)
            media[f.filename] = (f.file.read(), f.content_type)
            return out({"name": f.filename, "subfolder": "received", "type": "input"})
        if req.path == "/prompt":
            data = await req.json()
            id = data["prompt_id"]
            graphs.append(data["prompt"])
            pending.append([1, id, data["prompt"], {"client_id": data["client_id"]}])
            return out({"prompt_id": id})
        if req.path.startswith("/history/"):
            return out(history)
        if req.path == "/view":
            name = req.query["filename"]
            body, mime = media.get(name, (png, "image/png"))
            return web.Response(
                body=body,
                content_type=mime,
                headers={"Access-Control-Allow-Origin": "*"},
            )
        return web.Response(status=404)

    app = web.Application()
    app.router.add_route("*", "/{route:.*}", route)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    async with async_playwright() as p:
        b = await launch_chromium(p)
        page = await b.new_page(viewport={"width": 1440, "height": 930})
        page.set_default_timeout(9000)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(path.resolve().as_uri())
        await page.locator("#server").fill(f"http://127.0.0.1:{port}")
        await page.locator("#test").click()
        await page.get_by_text("已连接", exact=True).wait_for()
        video = base64.b64decode(
            await page.evaluate("""async()=>{
    const c=document.createElement('canvas');c.width=64;c.height=48;
    const g=c.getContext('2d');const stream=c.captureStream(24);
    const rec=new MediaRecorder(stream,{mimeType:'video/webm'});const parts=[];
    const done=new Promise(resolve=>rec.onstop=resolve);
    rec.ondataavailable=e=>parts.push(e.data);
    rec.start();for(let i=0;i<12;i++){g.fillStyle=i%2?'coral':'navy';g.fillRect(0,0,64,48);await new Promise(r=>setTimeout(r,45))}
    rec.stop();await done;stream.getTracks().forEach(t=>t.stop());
    return btoa(String.fromCharCode(...new Uint8Array(await new Blob(parts).arrayBuffer())));
  }""")
        )
        assert video
        # Distinct file bytes exercise slot ordering and exact-content deduplication.
        payloads = [
            ("花园.png", "image/png", png),
            ("短片.webm", "video/webm", video),
            ("语音.wav", "audio/wav", audio(1)),
            ("第二段.webm", "video/webm", video + b"x"),
            ("第二个.wav", "audio/wav", audio(2)),
        ]
        await page.get_by_role("button", name="添加素材").click()
        await page.get_by_role("dialog", name="选择素材").wait_for()
        await page.locator("#file").set_input_files(
            [{"name": n, "mimeType": m, "buffer": body} for n, m, body in payloads]
        )
        await page.locator(".material-thumb").nth(4).wait_for()

        async def counts():
            return await page.locator(
                "#materialTabs .queue-tab-count"
            ).all_text_contents()

        assert await counts() == ["5", "1", "2", "2"]
        picker = page.locator("#picker")
        tabs = picker.get_by_role("tablist", name="素材类型")
        editor = page.locator("#editor")
        await picker.locator("#closePicker").click()
        await editor.fill("混合：")

        async def choose(kind, name):
            await page.keyboard.insert_text("@")
            await tabs.get_by_role("tab", name=kind, exact=True).click()
            await picker.get_by_role("button", name=name, exact=True).click()
            await picker.wait_for(state="hidden")
            await page.keyboard.insert_text(" / ")

        await editor.focus()
        for category, name in [
            ("视频", "短片.webm"),
            ("图片", "花园.png"),
            ("音频", "语音.wav"),
            ("视频", "第二段.webm"),
            ("音频", "第二个.wav"),
            ("视频", "短片.webm"),
        ]:
            await choose(category, name)
        await page.keyboard.insert_text("结束")
        expected = "混合：<Video 1> / <Picture 1> / <Audio 1> / <Video 2> / <Audio 2> / <Video 1> / 结束"
        assert await page.evaluate("snapshot().prompt") == expected
        assert await page.locator("#refCount").inner_text() == "5"
        assert (
            await page.locator("#refUsage").inner_text()
            == "图片 1/9 · 视频 2/3 · 音频 2/3"
        )
        await page.reload()
        await page.get_by_text("草稿已保存", exact=True).wait_for()
        assert await page.evaluate("snapshot().prompt") == expected
        await page.get_by_role("button", name="添加素材").click()
        await page.wait_for_function(
            "Array.from(document.querySelectorAll('#materialTabs .queue-tab-count')).map(e=>e.textContent).join(',')==='5,1,2,2'"
        )
        await tabs.get_by_role("tab", name="音频", exact=True).press("Home")
        assert (
            await tabs.get_by_role("tab", name="全部").get_attribute("aria-selected")
            == "true"
        )
        await picker.locator("#closePicker").click()
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[0]?.id")
        assert uploads == [
            "短片.webm",
            "花园.png",
            "语音.wav",
            "第二段.webm",
            "第二个.wav",
        ]
        g = graphs[0]
        assert g["138"]["inputs"]["value"] == expected
        cond = g["136"]["inputs"]

        def source(key):
            id, index = cond[key]
            assert index == 0
            return g[id]

        for idx, name in enumerate(["短片.webm", "第二段.webm"]):
            node = source(f"ref_videos.ref_video_{idx}")
            assert node["class_type"] == "VHS_LoadVideo"
            assert (
                node["inputs"]["video"] == "received/" + name
                and node["inputs"]["force_rate"] == 24
            )
        for idx, name in enumerate(["语音.wav", "第二个.wav"]):
            node = source(f"ref_audios.ref_audio_{idx}")
            assert node == {
                "class_type": "LoadAudio",
                "inputs": {"audio": "received/" + name},
            }
        assert (
            source("ref_images.ref_image_0")["inputs"]["image"] == "received/花园.png"
        )
        assert not any(k.startswith("ref_video_audios.") for k in cond)
        data = await page.evaluate(
            "g=>graphJobData(serverAddress(),g,matchWorkflow(g)).form", g
        )
        assert sorted(x["kind"] for x in data["refs"]) == [
            "audio",
            "audio",
            "image",
            "video",
            "video",
        ]
        assert data["html"].count('data-kind="video"') == 3
        id = pending.pop()[1]
        history[id] = {
            "status": {"completed": True, "status_str": "success"},
            "outputs": {
                "152": {"images": [{"filename": "poster.png", "type": "output"}]}
            },
        }
        await page.get_by_text("已完成", exact=True).wait_for()
        await page.locator(".job-cover").click()
        await page.locator("#playerRefs audio").nth(1).wait_for()
        assert await page.locator("#playerRefs video").count() == 2
        assert not errors, errors
        await b.close()
    await runner.cleanup()
    print(
        f"PASS {path.name}: mixed import and counts, independent tags, exact repeat uploads, persisted library/draft, actual POST mappings, result media previews"
    )


asyncio.run(verify(html_path()))
