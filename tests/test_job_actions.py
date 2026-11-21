from support import html_path, launch_chromium
import asyncio, zipfile
from pathlib import Path
from playwright.async_api import async_playwright

root = Path(__file__).resolve().parent


async def verify():
    async with async_playwright() as p:
        b = await launch_chromium(p)
        c = await b.new_context(
            viewport={"width": 1440, "height": 900}, accept_downloads=True
        )
        page = await c.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await c.route("**/view?*", lambda route: route.fulfill(status=503))
        url = html_path().as_uri()
        await page.goto(url)
        await page.evaluate("""async()=>{
    const base='http://127.0.0.1:8199';
    localStorage.setItem('frameform.server',base);
    const draftKey='frameform.draft.v1.'+location.pathname;
    writeLocal(draftKey,{...JSON.parse(localStorage.getItem(draftKey)),server:base});
    const results=[{kind:'video',filename:'同名.mp4',subfolder:'Video',type:'output'},{kind:'image',filename:'首帧.png',subfolder:'Video',type:'output'}];
    const fixtures=[
      {n:1,client:'local-one',id:'comfy-one',base,state:'done',sent:true,title:'任务甲',results,endedAt:1},
      {n:2,client:'local-two',id:'comfy-two',base,state:'done',sent:true,title:'任务乙',results,endedAt:2},
      {n:3,client:'local-three',id:'comfy-three',base,state:'failed',sent:true,title:'失败任务',endedAt:3},
      {n:4,client:'local-four',id:'comfy-four',base,state:'running',sent:false,title:'进行中的任务',startedAt:Date.now()}
    ];
    writeLocal(historyKey,fixtures.slice(0,3));
    sessionStorage.setItem(sessionKey,JSON.stringify(fixtures));
    for(const j of fixtures.slice(0,2)){
      await fileData(mediaKey(j,results[0]),new Blob(['video-'+j.n],{type:'video/mp4'}));
      await fileData(mediaKey(j,results[1]),new Blob(['poster-'+j.n],{type:'image/png'}));
    }
  }""")
        await page.reload()
        await page.evaluate(
            """()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedId=value;}}})"""
        )
        row1 = page.locator(".job").filter(has_text="任务甲")
        row2 = page.locator(".job").filter(has_text="任务乙")
        row3 = page.locator(".job").filter(has_text="失败任务")
        row4 = page.locator(".job").filter(has_text="进行中的任务")
        await row1.get_by_role("button", name="复制任务 ID").click()
        assert await page.evaluate("window.copiedId") == "comfy-one"
        await row3.get_by_role("button", name="复制任务 ID").click()
        assert await page.evaluate("window.copiedId") == "comfy-three"
        async with page.expect_download() as result:
            await row1.get_by_role("button", name="下载", exact=True).click()
        saved = await result.value
        assert saved.suggested_filename == "同名.mp4"
        assert Path(await saved.path()).read_bytes() == b"video-1"

        for row in [row1, row2, row3]:
            await row.get_by_role("checkbox").check()
        assert await page.locator("#selectedCount").inner_text() == "已选 3 条"
        await row4.get_by_role("checkbox").check()
        assert await page.locator("#batchDelete").is_disabled()
        await row4.get_by_role("checkbox").uncheck()
        async with page.expect_download() as result:
            await page.locator("#batchDownload").click()
        archive = await result.value
        assert archive.suggested_filename.endswith(".zip")
        with zipfile.ZipFile(await archive.path()) as z:
            assert z.testzip() is None
            assert z.namelist() == ["任务-1-1-同名.mp4", "任务-2-2-同名.mp4"]
            assert [z.read(name) for name in z.namelist()] == [b"video-1", b"video-2"]
        assert "跳过 1 条" in await page.locator("#queueNotice").inner_text()
        await page.evaluate("clearOutputCache(jobs.find(j=>j.n===2))")
        async with page.expect_download() as result:
            await page.locator("#batchDownload").click()
        with zipfile.ZipFile(await (await result.value).path()) as z:
            assert z.namelist() == ["任务-1-1-同名.mp4"]
        assert "任务 2 获取失败" in await page.locator("#queueNotice").inner_text()
        await page.set_viewport_size({"width": 390, "height": 850})
        assert await page.evaluate("document.documentElement.scrollWidth===innerWidth")
        await page.set_viewport_size({"width": 1440, "height": 900})
        await page.locator("#batchDelete").click()
        await page.locator("#keepTasks").click()
        assert await page.locator(".job").count() == 4

        other = await c.new_page()
        await other.goto(url)
        assert await other.locator(".job").count() == 3
        await row3.get_by_role("button", name="删除", exact=True).click()
        await page.locator("#confirmDelete").click()
        await (
            other.locator(".job").filter(has_text="失败任务").wait_for(state="detached")
        )
        assert await page.locator(".job").count() == 3
        await page.locator("#batchDelete").click()
        await page.locator("#confirmDelete").click()
        await other.locator(".job").first.wait_for(state="detached")
        await page.wait_for_function(
            """async()=>!(await fileData('output:http://127.0.0.1:8199:comfy-one:同名.mp4:Video'))"""
        )
        await page.reload()
        assert await page.locator(".job").count() == 0
        assert await page.locator("#queueTools").is_hidden()
        assert await page.locator("#empty").is_visible()
        assert not errors, errors
        print(
            "PASS · copy ID, single download, ZIP with Unicode same-name results and verified CRC, cancellation of delete, blocked active deletion, single/bulk deletion across tabs, cache removal and refresh"
        )
        await b.close()


asyncio.run(verify())
