from support import html_path, launch_chromium
import asyncio, io, base64, zlib, sys
from pathlib import Path
from PIL import Image
from aiohttp import web
from playwright.async_api import async_playwright

root = Path(__file__).resolve().parent
http_mode = "--http" in sys.argv
poster = io.BytesIO()
Image.new("RGB", (80, 50), "#f0a971").save(poster, format="PNG")
png = poster.getvalue()


class Mock:
    def __init__(self):
        self.pending = []
        self.running = []
        self.history = {}
        self.sockets = {}
        self.graphs = []
        self.uploads = []
        self.cancels = []
        self.reject = False
        self.legacy = False
        self.movie = b""
        self.return_id = False
        self.delay = 0
        self.upload_delay = 0

    async def route(self, req):
        path = req.path
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
        if path == "/Frameform.html":
            return web.FileResponse(html_path())
        if path == "/system_stats":
            return out({"system": {}, "devices": []})
        if path == "/ws":
            s = web.WebSocketResponse()
            await s.prepare(req)
            self.sockets[req.query["clientId"]] = s
            async for msg in s:
                pass
            return s
        if path == "/upload/image":
            data = await req.post()
            self.uploads.append(data["image"].filename)
            await asyncio.sleep(self.upload_delay)
            return out(
                {"name": data["image"].filename, "subfolder": "saved", "type": "input"}
            )
        if path == "/prompt":
            d = await req.json()
            if self.reject:
                return web.json_response(
                    {
                        "error": {"message": "Validation failed"},
                        "node_errors": {
                            "127": {
                                "class_type": "UNETLoader",
                                "errors": [
                                    {
                                        "message": "Model missing",
                                        "details": "missing.safetensors",
                                    }
                                ],
                            }
                        },
                    },
                    status=400,
                    headers={"Access-Control-Allow-Origin": "*"},
                )
            id = "old-" + d["client_id"] if self.return_id else d["prompt_id"]
            self.pending.append([1, id, d["prompt"], {"client_id": d["client_id"]}])
            self.graphs.append(d["prompt"])
            await asyncio.sleep(self.delay)
            return out({"prompt_id": id, "number": 1})
        if path == "/queue":
            if req.method == "GET":
                return out(
                    {"queue_running": self.running, "queue_pending": self.pending}
                )
            d = await req.json()
            self.cancels.append(d)
            self.pending = [r for r in self.pending if r[1] not in d["delete"]]
            return out({})
        if path.startswith("/history"):
            if path == "/history":
                return out(self.history)
            id = path.split("/")[-1]
            return out({id: self.history[id]} if id in self.history else {})
        if path.startswith("/api/jobs") and path.endswith("/cancel"):
            if self.legacy:
                return web.Response(
                    status=404, headers={"Access-Control-Allow-Origin": "*"}
                )
            id = path.split("/")[-2]
            await self.cancel(id)
            return out({"cancelled": True})
        if path == "/interrupt":
            d = await req.json()
            await self.cancel(d["prompt_id"])
            return out({})
        if path == "/view":
            f = req.query["filename"]
            return web.Response(
                body=png if f.endswith(".png") else self.movie,
                content_type="image/png" if f.endswith(".png") else "video/webm",
                headers={"Access-Control-Allow-Origin": "*"},
            )
        return web.Response(status=404)

    async def cancel(self, id):
        self.cancels.append(id)
        self.pending = [r for r in self.pending if r[1] != id]
        for r in list(self.running):
            if r[1] == id:
                self.running.remove(r)
                self.history[id] = {
                    "status": {
                        "status_str": "error",
                        "completed": False,
                        "messages": [["execution_interrupted", {"prompt_id": id}]],
                    }
                }

    async def ws(self, r, t, **kw):
        await self.sockets[r[3]["client_id"]].send_json(
            {"type": t, "data": {"prompt_id": r[1], **kw}}
        )


async def main():
    api = Mock()
    app = web.Application()
    app.router.add_route("*", "/{any:.*}", api.route)
    runner = web.AppRunner(app, shutdown_timeout=2)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    async with async_playwright() as p:
        b = await launch_chromium(p)
        context = await b.new_context(viewport={"width": 1440, "height": 1000})
        page = await context.new_page()
        page.set_default_timeout(7000)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        if http_mode:
            await page.add_init_script(
                "window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('frameform-test', {create:true})"
            )
        location = (
            f"http://127.0.0.1:{port}/Frameform.html"
            if http_mode
            else html_path().as_uri()
        )
        await page.goto(location)
        await page.set_viewport_size({"width": 390, "height": 844})
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await page.set_viewport_size({"width": 1440, "height": 1000})
        await page.locator("#test").click()
        await page.get_by_text("连接失败", exact=True).wait_for()
        await page.locator("#server").fill(f"http://127.0.0.1:{port}")
        await page.locator("#test").click()
        await page.get_by_text("已连接", exact=True).wait_for()
        await page.locator("#generate").click()
        await page.get_by_text("请填写提示词，再加入生成队列。").wait_for()
        ed = page.locator("#editor")
        await ed.click()
        await page.keyboard.insert_text("镜头跟随@")
        await page.locator("dialog[open]").wait_for()

        def image_file(name, content=None):
            pixel = zlib.crc32((content or name).encode()).to_bytes(4, "big")[:3]
            buf = io.BytesIO()
            Image.new("RGB", (8, 8), tuple(pixel)).save(buf, format="PNG")
            return {"name": name, "mimeType": "image/png", "buffer": buf.getvalue()}

        async def file(name, content=None):
            await page.locator("#file").set_input_files(image_file(name, content))
            await page.locator("#picker").wait_for(state="hidden")

        await file("人像.png")
        await page.keyboard.insert_text("缓慢前行。")
        await page.keyboard.press("Control+Home")
        await page.evaluate(
            "()=>{const r=document.createRange();r.selectNodeContents(editor);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)}"
        )
        await page.keyboard.insert_text("@")
        await file("场景.png")
        await ed.locator(".mention").first.hover()
        await page.locator("#tooltip:not([hidden])").wait_for()
        assert "<Picture" not in await ed.inner_text()
        duration = page.get_by_role("slider", name="视频时长")
        assert await duration.input_value() == "26"
        assert "634 帧" in await page.locator("#timing").inner_text()
        await duration.fill("5")
        assert "5.17 秒（124 帧）" in await page.locator("#timing").inner_text()
        size = page.get_by_role("combobox", name="输出尺寸")
        assert await size.locator("option:checked").inner_text() == "1344 × 768"
        for ratio in ("1:1", "9:16", "16:9"):
            await page.locator("#ratio").select_option(ratio)
            x, y = map(int, ratio.split(":"))

            def dims(mp):
                k = (mp * 1024**2 / (x * y)) ** 0.5
                return " × ".join(str(32 * round(side * k / 32)) for side in (x, y))

            opts = await size.locator("option").evaluate_all(
                "opts=>opts.map(o=>[o.text,Number(o.value)])"
            )
            assert len(set(s for s, _ in opts)) == len(opts)
            assert set(s for s, _ in opts) == set(dims(n / 100) for n in range(25, 201))
            assert all(dims(mp) == s for s, mp in opts)
        await size.select_option(label="1024 × 576")
        await page.locator("#steps").focus()
        await page.keyboard.press("ArrowRight")
        await page.locator("#ratio").select_option("9:16")
        await page.locator("#manageServers").click()
        await page.locator("#serverName").fill("GPU 测试")
        await page.locator("#saveServer").click()
        await page.locator("#manageServers").click()
        await page.locator("#serverName").fill("备用服务器")
        await page.locator("#serverURL").fill("http://127.0.0.1:8199")
        await page.locator("#saveServer").click()
        await page.locator("#serverList").select_option(label="GPU 测试")
        prompt_before = await page.evaluate("snapshot().prompt")
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert await page.evaluate("snapshot().prompt") == prompt_before
        assert await page.locator("#serverList option").count() == 3
        assert (
            await page.locator("#serverList option:checked").inner_text() == "GPU 测试"
        )
        assert await size.locator("option:checked").inner_text() == "576 × 1024"
        assert (
            await duration.input_value() == "5"
            and await page.locator("#steps").input_value() == "7"
        )
        await ed.locator(".mention").first.hover()
        await page.wait_for_function(
            "!document.querySelector('#tooltip').hidden && document.querySelector('#tooltip img').naturalWidth===8"
        )
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[0]?.id")
        g = api.graphs[0]
        print("Prompt:", g["138"]["inputs"]["value"])
        assert g["138"]["inputs"]["value"] == "<Picture 2>镜头跟随<Picture 1>缓慢前行。"
        assert (
            g["149"]["inputs"]["image"] == "saved/人像.png"
            and g["153"]["inputs"]["image"] == "saved/场景.png"
        )
        assert (
            len([name for name in g["136"]["inputs"] if name.startswith("ref_images.")])
            == 2
        )
        if html_path().name == "Frameform.html":
            assert (
                len([node for node in g.values() if node["class_type"] == "LoadImage"])
                == 2
            )
        assert len(g["147"]["inputs"]["sigmas"].split(",")) == 8
        assert g["115"]["inputs"]["aspect_ratio"] == "9:16 (Portrait Widescreen)"
        assert (
            g["115"]["inputs"]["megapixels"] == 0.56
            and await size.locator("option:checked").inner_text() == "576 × 1024"
        )
        first_frame = next(
            node for node in g.values() if node["class_type"] == "SaveImage"
        )
        assert g[first_frame["inputs"]["images"][0]]["inputs"]["image"] == ["122", 0]
        await page.locator("#ratio").select_option("1:1")
        await size.select_option(label="1024 × 1024")
        await duration.fill("12")
        # Mix library reuse with a renamed, byte-identical copy selected from disk.
        await ed.fill("")
        await ed.focus()
        for index, name in enumerate(["人像.png", "场景.png", "人像.png"]):
            await page.keyboard.insert_text("@")
            await page.locator(".thumb").filter(has_text=name).click()
            await page.keyboard.insert_text(" / ")
        await page.keyboard.insert_text("@")
        await file("重命名.png", "人像.png")
        assert (
            await ed.locator(".mention").count() == 4
            and await page.locator("#refCount").inner_text() == "2"
        )
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[1]?.id")
        second = api.graphs[1]
        assert (
            second["138"]["inputs"]["value"]
            == "<Picture 1> / <Picture 2> / <Picture 1> / <Picture 1>"
        )
        assert api.uploads == ["人像.png", "场景.png"] * 2
        assert [
            second[link[0]]["inputs"]["image"]
            for name, link in second["136"]["inputs"].items()
            if name.startswith("ref_images.")
        ] == ["saved/人像.png", "saved/场景.png"]
        print(
            "Verified repeated-reference POST:",
            second["138"]["inputs"]["value"],
            "with two uploads and two slots",
        )
        await ed.fill("第二条视频")
        assert api.graphs[1]["115"]["inputs"]["aspect_ratio"] == "1:1 (Square)"
        assert api.graphs[1]["115"]["inputs"]["megapixels"] == 0.98
        assert await page.evaluate("jobs.map(j=>j.dimensions)") == [
            "576 × 1024",
            "1024 × 1024",
        ]
        assert [g["132"]["inputs"]["value"] for g in api.graphs[:2]] == [5, 12]
        assert all(
            g["131"]["inputs"]["values.a"] == ["132", 0]
            and g["136"]["inputs"]["length"] == ["131", 1]
            for g in api.graphs[:2]
        )
        assert "5 秒" in await page.locator(".job").last.inner_text()
        r = api.pending.pop(0)
        api.running.append(r)
        await api.ws(r, "progress", node="125", value=3, max=7)
        await page.get_by_text("采样 3 / 7").wait_for()
        await page.locator(".job").last.get_by_text("运行 00:01").wait_for()
        await page.locator(".job").last.locator(".job-name").click()
        await page.get_by_text("草稿已保存").wait_for()
        assert await page.evaluate("snapshot().prompt") == prompt_before
        assert await size.locator("option:checked").inner_text() == "576 × 1024"
        assert (
            "9:16"
            in await page.locator(".job").last.locator(".job-metrics").inner_text()
        )
        await ed.fill("第二条视频")
        await duration.fill("12")
        await page.locator(".job").first.get_by_text("取消", exact=True).click()
        await page.locator(".job").first.get_by_text("已取消", exact=True).wait_for()
        assert len(api.running) == 1 and not api.pending
        api.legacy = True
        await page.locator(".job").last.get_by_text("取消", exact=True).click()
        await page.locator(".job").last.get_by_text("已取消", exact=True).wait_for()
        assert not api.running and api.cancels[-1] == r[1]
        assert "总耗时" in await page.locator(".job").last.inner_text()
        api.return_id = True
        await page.locator("#generate").click()
        await page.wait_for_function("jobs[2]?.id")
        df = api.graphs[-1]
        assert not [k for k in df["136"]["inputs"] if k.startswith("ref_images.")]
        if html_path().name == "Frameform.html":
            assert not any(node["class_type"] == "LoadImage" for node in df.values())
        id = api.pending[0][1]
        await page.reload()
        await page.wait_for_function("jobs.length===3 && jobs[2].state==='queued'")
        await page.locator(".job").first.get_by_text("取消", exact=True).click()
        await page.locator(".job").first.get_by_text("已取消", exact=True).wait_for()
        assert {"delete": [id]} in api.cancels
        assert "12 秒" in await page.locator(".job").first.inner_text()
        api.movie = base64.b64decode(
            await page.evaluate(
                """async()=>{const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');const stream=c.captureStream(10),rec=new MediaRecorder(stream,{mimeType:'video/webm'}),parts=[];rec.ondataavailable=e=>parts.push(e.data);const done=new Promise(r=>rec.onstop=r);rec.start();for(let i=0;i<4;i++){g.fillStyle=i%2?'orange':'black';g.fillRect(0,0,64,64);await new Promise(r=>setTimeout(r,100))}rec.stop();await done;stream.getTracks().forEach(t=>t.stop());return btoa(String.fromCharCode(...new Uint8Array(await new Blob(parts).arrayBuffer())))}"""
            )
        )
        await page.locator("#openSettings").click()
        await page.locator("#autoCache").check()
        if http_mode:
            await page.locator("#pickDirectory").click()
            await page.get_by_text("frameform-test", exact=True).wait_for()
        await page.locator("#closeSettings").click()
        await ed.fill("完成测试")
        await page.locator("#addRef").click()
        await file("保留参考.png")
        await page.locator("#generate").click()
        await page.wait_for_function("jobs.at(-1)?.id")

        id = api.pending.pop()[1]
        api.history[id] = {
            "status": {"status_str": "success", "completed": True, "messages": []},
            "outputs": {
                "152": {
                    "gifs": [
                        {
                            "filename": "video.webm",
                            "subfolder": "Video",
                            "type": "output",
                            "format": "video/webm",
                        }
                    ]
                },
                "166": {"images": [{"filename": "poster.png", "type": "output"}]},
            },
        }
        await page.get_by_text(
            "已保存到本机目录" if http_mode else "视频已缓存"
        ).wait_for()
        if http_mode:
            assert await page.evaluate(
                "async()=>{for await (const handle of directory.values()){if(handle.kind==='file' && handle.name.endsWith('video.webm'))return (await handle.getFile()).size>0}return false}"
            )

        await page.wait_for_function(
            "document.querySelector('.job-cover img')?.naturalWidth===80"
        )
        await ed.fill("草稿与任务不同")
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert await ed.inner_text() == "草稿与任务不同"
        await page.route("**/view?*", lambda route: route.abort())
        await page.locator(".job").first.locator(".job-cover").click()
        try:
            await page.wait_for_function(
                "document.querySelector('#player video')?.readyState>=1"
            )
        except Exception:
            print(
                "player diagnostics",
                await page.evaluate(
                    "()=>({open:player.open, stage:document.querySelector('#playerStage').innerHTML, videoError:document.querySelector('#player video')?.error?.message, tasks:jobs.map(j=>[j.n,j.state,j.title]), errors:document.querySelector('#playerError').textContent})"
                ),
                "payload size",
                len(api.movie),
                "page errors",
                errors,
            )
            raise
        assert (await page.locator("#player video").get_attribute("src")).startswith(
            "blob:"
        )
        assert "完成测试" in await page.locator("#playerPrompt").inner_text()
        assert await page.locator("#playerRefs img").count() == 1
        async with page.expect_download() as download:
            await page.locator("#download").click()
        assert (await download.value).suggested_filename == "video.webm"

        await page.locator("#reuse").click()
        await page.locator("#player").wait_for(state="hidden")
        await page.get_by_text("草稿已保存").wait_for()
        assert (await page.evaluate("snapshot().prompt")) == "完成测试<Picture 1>"
        await ed.fill("选择成功任务也恢复")
        await page.locator(".job").first.locator(".job-name").click()
        await page.wait_for_function(
            "document.querySelector('#player video')?.readyState>=1"
        )
        await page.locator("#closePlayer").click()
        assert (await page.evaluate("snapshot().prompt")) == "完成测试<Picture 1>"
        await page.unroute("**/view?*")
        api.reject = True
        await page.locator("#generate").click()
        await page.get_by_text("失败", exact=True).wait_for()
        assert "Model missing" in await page.locator(".job").first.inner_text()
        api.reject = False
        # Verify selection order after deletion and nine-slot binding.
        await page.locator("#steps").fill("6")
        await ed.fill("选择")
        await page.locator("#addRef").click()
        await file("角色.png")
        for i in range(8):
            await page.locator("#addRef").click()
            # Same name as the first file, but distinct image content, occupies another slot.
            await file("角色.png" if i == 0 else f"{i}.png", f"different{i}")
        assert await page.locator("#refCount").inner_text() == "9"
        await page.locator("#addRef").click()
        await page.locator("#file").set_input_files(image_file("第十张.png"))
        await page.get_by_text("已达到图片素材上限（9）", exact=False).wait_for()
        await page.locator(".thumb").filter(has_text="角色.png").first.click()
        assert (
            await ed.locator(".mention").count() == 10
            and await page.locator("#refCount").inner_text() == "9"
        )
        await page.evaluate(
            "()=>{editor.querySelector('.mention').remove();editorChanged()}"
        )
        assert await page.locator("#refCount").inner_text() == "9"
        assert await page.evaluate("snapshot().prompt.endsWith('<Picture 1>')")
        await page.evaluate(
            "()=>{editor.querySelector('.mention:last-of-type').remove();editorChanged()}"
        )
        assert await page.locator("#refCount").inner_text() == "8"
        values = await page.evaluate(
            "()=>{const j=snapshot();const g=buildGraph(j,j.files.map(f=>f.name));return [j.prompt,Object.keys(g['136'].inputs).filter(k=>k.startsWith('ref_images')).length,g['147'].inputs.sigmas===template['147'].inputs.sigmas]}"
        )
        assert (
            "<Picture 8>" in values[0]
            and "<Picture 9>" not in values[0]
            and values[1:] == [8, True]
        )
        api.upload_delay = 1
        prev = len(api.graphs)
        await page.locator("#generate").click()
        await page.get_by_text("上传素材 1 / 8").wait_for()
        await page.locator(".job").first.get_by_text("取消", exact=True).click()
        await asyncio.sleep(0.15)
        assert len(api.graphs) == prev
        # A server may queue the job before its /prompt response has reached the browser.
        api.delay = 2
        api.return_id = False
        api.legacy = False
        await ed.fill("取消正在提交的任务")
        await page.locator("#generate").click()
        async with asyncio.timeout(10):
            while not api.pending:
                await asyncio.sleep(0.05)
        id = api.pending[-1][1]
        await page.locator(".job").first.get_by_text("取消", exact=True).click()
        await page.locator(".job").first.get_by_text("已取消", exact=True).wait_for()
        assert id in api.cancels
        api.delay = 0
        await ed.fill("消失的任务")
        await page.locator("#generate").click()
        await page.wait_for_function("jobs.at(-1).id")
        api.pending.clear()
        await page.locator(".job").first.get_by_text("取消", exact=True).click()
        await page.get_by_text("已停止跟踪", exact=True).wait_for()
        page2 = await page.context.new_page()
        await page2.goto(location)
        await page2.get_by_text("草稿已保存").wait_for()
        assert await page2.locator("#editor").inner_text() == "消失的任务"
        assert await page2.get_by_text("已停止跟踪", exact=True).count() == 1
        await page2.close()
        assert not errors, errors
        print(
            "PASS · connection, empty prompt, mention order, hover, graph slots, dimensions, sigmas, two jobs, WS progress, queue delete, interrupt, ID cancellation, reload, still/video playback, node errors, mobile layout"
        )
        await b.close()
    await runner.cleanup()


asyncio.run(main())
