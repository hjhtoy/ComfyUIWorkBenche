"""Exercise the production HTML, two independent clients, background execution and a portable restore."""
import asyncio
import io
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, web
from PIL import Image
from playwright.async_api import async_playwright
from support import ROOT, launch_chromium

sys.path.insert(0,str(ROOT))
from workspace.server import create_app
from workspace.store import Store, restore
from workspace.migration import migrate


async def listen(app):
    runner = web.AppRunner(app,shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner,"127.0.0.1",0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


async def verify(temp):
    image = io.BytesIO()
    Image.new("RGB",(20,16),"tomato").save(image,format="PNG")
    png = image.getvalue()
    root = temp/"data"
    html = ROOT/"dist"/"Frameform.html"
    entries = []
    uploaded = []
    remote = web.Application()
    async def comfy(req):
        if req.path=="/upload/image":
            form = await req.post()
            uploaded.append(form["image"].file.read())
            return web.json_response({"name":"input.png","subfolder":"received"})
        if req.path=="/prompt":
            entries.append(await req.json())
            # The server accepted the POST but its confirmation was lost.
            raise web.HTTPServiceUnavailable()
        if req.path=="/queue":
            return web.json_response(dict(queue_running=[],queue_pending=[]))
        if req.path.startswith("/history"):
            return web.json_response({v["prompt_id"]:{
                "prompt":[0,v["prompt_id"],v["prompt"],{"client_id":v["client_id"]}],
                "status":{"completed":True},"outputs":{"152":{"images":[{"filename":"still.png"}]}}
            } for v in entries})
        if req.path=="/view":
            return web.Response(body=png,content_type="image/png")
        return web.json_response({"system":{},"devices":[]})
    remote.router.add_route("*","/{tail:.*}",comfy)
    cr,base = await listen(remote)
    runner,url = await listen(create_app(root,html,outputs=temp/"outputs"))
    try:
        async with async_playwright() as p:
            browser = await launch_chromium(p)
            one,two = await browser.new_context(),await browser.new_context()
            a,b = await one.new_page(),await two.new_page()
            errors=[]
            for page in (a,b):
                page.on("pageerror",lambda e: errors.append(str(e)))
                page.set_default_timeout(10000)
            await a.goto(url)
            await a.locator("#server").fill(base)
            await a.locator("#editor").fill("背景")
            await a.get_by_text("草稿已保存",exact=True).wait_for()
            await b.goto(url+"/Frameform.html")
            await b.wait_for_function("editor.textContent==='背景'")
            await b.locator("#addRef").click()
            await a.locator("#addRef").click()
            await a.locator("#newFolder").click()
            await a.locator("#folderName").fill("场景")
            await a.locator("#folderForm button").click()
            await b.get_by_role("button",name="场景",exact=True).click()
            await a.locator("#file").set_input_files(dict(name="参考.png",mimeType="image/png",buffer=png))
            await b.get_by_role("button",name="参考.png",exact=True).wait_for()
            await a.locator("#closePicker").click()
            await a.locator("#editor").focus()
            await a.locator("#editor").evaluate("(e)=>getSelection().collapse(e.firstChild,2)")
            await a.keyboard.insert_text("@")
            await a.get_by_role("button",name="参考.png",exact=True).click()
            await a.locator("#generate").click()
            await b.locator("#closePicker").click()
            await b.locator(".job").wait_for()
            await one.close()
            await two.close()
            for _ in range(80):
                if entries: break
                await asyncio.sleep(.1)
            assert len(entries)==1 and uploaded==[png]
            assert "received/input.png" in str(entries[0]["prompt"])
            await runner.cleanup()
            runner,url = await listen(create_app(root,html,outputs=temp/"outputs"))
            async with ClientSession() as http:
                for _ in range(100):
                    async with http.get(url+"/workspace/jobs?workflow=pika-h3") as res:
                        job=(await res.json())[0]
                    if job.get("mediaNote")=="已保存到工作区": break
                    await asyncio.sleep(.1)
                assert job.get("mediaNote")=="已保存到工作区" and len(entries)==1, job
                exported=sorted((temp/"outputs").glob("*.png"))
                assert exported and exported[0].read_bytes()==png, exported
                async with http.get(url+"/workspace/settings") as res:
                    assert res.status==200
                    settings=await res.json()
                    assert settings["outputs"]==str((temp/"outputs").resolve()), settings
                custom=temp/"custom-outputs"
                async with http.put(url+"/workspace/settings",json={"rev":settings["rev"],"outputs":str(custom)},headers={"X-Frameform":"1"}) as res:
                    assert res.status==200
                    updated=await res.json()
                    assert updated["outputs"]==str(custom.resolve()), updated
                assert custom.is_dir()
                async with http.get(url+"/workspace/settings?workflow=another-workflow") as res:
                    other_settings = await res.json()
                    assert not other_settings["configured"]
                    assert other_settings["outputs"] == settings["default"]
                async with http.get(url+"/workspace/backup") as res:
                    assert res.status==200
                    archive=temp/"backup.zip"
                    archive.write_bytes(await res.read())
            await runner.cleanup()
            fresh=temp/"new-host"
            restore(archive,fresh)
            runner,url=await listen(create_app(fresh,html,outputs=temp/"outputs"))
            view=await browser.new_page()
            await view.goto(url)
            await view.locator("#editor .mention").wait_for()
            ui_outputs=temp/"ui-outputs"
            ui_outputs.mkdir()
            picker = AsyncMock(side_effect=[None, ui_outputs.resolve(), ui_outputs.resolve()])
            with patch("workspace.server.choose_output_directory", picker), patch(
                "workspace.server.picker_executable", return_value="test-picker"
            ):
                await view.locator("#openSettings").click()
                original = str(custom.resolve())
                await view.locator("#directoryName", has_text=original).wait_for()
                async with view.expect_response("**/workspace/settings/choose-directory?*"):
                    await view.locator("#pickDirectory").click()
                assert await view.locator("#saveOutputsPath").is_disabled()
                assert await view.locator("#directoryName").inner_text() == original
                await view.locator("#pickDirectory").click()
                await view.locator("#directoryName", has_text=str(ui_outputs.resolve())).wait_for()
                await view.locator("#closeSettings").click()
                await view.locator("#openSettings").click()
                await view.locator("#directoryName", has_text=original).wait_for()
                await view.locator("#pickDirectory").click()
                await view.locator("#directoryName", has_text=str(ui_outputs.resolve())).wait_for()
                await view.locator("#saveOutputsPath").click()
                await view.locator("#outputsStatus", has_text="已保存").wait_for()
            assert picker.await_count == 3
            assert picker.call_args.args == (custom.resolve(),)
            await view.locator("#closeSettings").click()
            await view.locator("#generate").click()
            # Hosted jobs are archived by the worker; the browser must not save again.
            exported = ui_outputs / "背景.png"
            for _ in range(150):
                if exported.exists():
                    break
                await asyncio.sleep(0.1)
            assert exported.is_file() and exported.read_bytes() == png, list(
                ui_outputs.iterdir()
            )
            await view.locator(".job-cover").first.click()
            await view.locator("#playerStage img").wait_for()
            await view.locator("#playerRefs img").wait_for()
            # Downloading a finished result must work through the workspace host.
            async with view.expect_download() as download:
                await view.locator("#download").click()
            saved = await download.value
            assert saved.suggested_filename=="背景.png"
            await view.locator("#closePlayer").click()
            await view.locator("#openSettings").click()
            await view.locator("#directoryName", has_text=str(ui_outputs.resolve())).wait_for()
            await view.locator("#clearDirectory").click()
            await view.locator("#saveOutputsPath").click()
            await view.locator("#outputsStatus", has_text="已保存").wait_for()
            await view.locator("#closeSettings").click()
            await view.locator(".job").first.get_by_role("button", name="删除", exact=True).click()
            delete_files = view.get_by_role("checkbox", name="同时删除本地结果文件")
            assert not await delete_files.is_checked()
            await delete_files.check()
            await view.locator("#confirmDelete").click()
            await view.locator("#deleteTasks").wait_for(state="hidden")
            assert not exported.exists()
            assert await view.locator(".job").count() == 1
            kept = next((temp/"outputs").glob("*.png"))
            await view.locator(".job").get_by_role("checkbox").check()
            await view.locator("#batchDelete").click()
            assert not await delete_files.is_checked()
            await view.locator("#confirmDelete").click()
            await view.locator("#deleteTasks").wait_for(state="hidden")
            assert not await view.locator(".job").count()
            assert kept.read_bytes() == png
            assert not errors, errors
            await view.close()
            # Legacy data must originate in the old browser and path.
            old=await browser.new_page()
            await old.goto(html.as_uri())
            await old.locator("#editor").fill("迁移草稿")
            await old.locator("#addRef").click()
            await old.locator("#file").set_input_files(dict(name="旧图.png",mimeType="image/png",buffer=png))
            await old.get_by_role("button",name="旧图.png").wait_for()
            await old.locator("#closePicker").click()
            await old.locator("#openSettings").click()
            async with old.expect_download() as download:
                await old.locator("#exportWorkspace").click()
            transfer=temp/"old.ffdata"
            await (await download.value).save_as(transfer)
            migrate(transfer,temp/"migrated")
            imported=Store(temp/"migrated")
            try:
                assert "迁移草稿" in imported.record("frameform.draft.v1.pika-h3")["value"]["html"]
                ref=imported.record("frameform.material-library.v1.pika-h3")["value"][0]
                assert (imported.root/imported.media("image:"+ref["id"])["path"]).read_bytes()==png
            finally:
                imported.db.close()
            await browser.close()
    finally:
        await runner.cleanup()
        await cr.cleanup()

with tempfile.TemporaryDirectory() as d:
    asyncio.run(verify(Path(d)))
print("PASS: independent browsers, background submission, crash reconciliation, media archive, backup/restore and legacy migration")
