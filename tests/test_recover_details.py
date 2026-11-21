from support import html_path, launch_chromium
import asyncio, io
from PIL import Image
from playwright.async_api import async_playwright


async def main(path):
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context()
        page = await context.new_page()
        errors = []
        requested = []
        records = {}
        page.on("pageerror", lambda e: errors.append(str(e)))
        finish = asyncio.Event()
        png = io.BytesIO()
        Image.new("RGB", (10, 7), "orange").save(png, format="PNG")

        async def route(r):
            url = r.request.url
            headers = {"Access-Control-Allow-Origin": "*"}
            if "/history/" in url:
                requested.append(url.rsplit("/", 1)[-1])
                await finish.wait()
                return await r.fulfill(json=records, headers=headers)
            if "/view?" in url:
                if "filename=old.mp4" in url:
                    return await r.fulfill(
                        body=b"video", content_type="video/mp4", headers=headers
                    )
                return await r.fulfill(
                    body=png.getvalue(), content_type="image/png", headers=headers
                )
            return await r.fulfill(
                json={"queue_running": [], "queue_pending": []}, headers=headers
            )

        await context.route("http://127.0.0.1:8188/**", route)
        await page.goto(path.resolve().as_uri())
        records = await page.evaluate(r"""()=>{
    const base='http://127.0.0.1:8188';
    const form={html:'本地会话保留的提示词',refs:[],server:base};
    const results=[{kind:'video',filename:'old.mp4',subfolder:'',type:'output'}];
    const items=[
      {n:1,client:'legacy',id:'legacy',title:'等待恢复的旧记录'},
      {n:2,client:'known',id:'known',title:'合并测试',form},
      {n:3,client:'missing',id:'missing',title:'服务器无历史记录'}
    ].map((j,i)=>({...j,base,state:'done',results,endedAt:i+1}));
    sessionStorage.setItem(sessionKey,JSON.stringify(items));
    writeLocal(historyKey,items.map(({form,...record})=>record));
    const graph=buildGraph({prompt:'历史原文\n镜头朝向<Picture 1>，随后再次看向<Picture 1>。',ratio:'9:16',mp:.56,duration:11,steps:7},['folder/旧参考.png']);
    return {legacy:{prompt:[1,'legacy',graph,{}],outputs:{},status:{completed:true}}};
  }""")
        await page.reload()
        known = page.locator(".job").filter(has_text="合并测试")
        await known.locator(".job-cover").click()
        await page.get_by_text("本地会话保留的提示词", exact=True).wait_for()
        assert requested == []
        await page.locator("#closePlayer").click()
        old = page.locator(".job").filter(has_text="等待恢复的旧记录")
        await old.locator(".job-cover").click()
        await page.get_by_text("正在恢复任务详情…").wait_for()
        await page.locator("#playerStage video").wait_for(state="attached")
        assert await page.locator("#reuse").is_disabled()
        finish.set()
        await page.locator("#playerPrompt").filter(has_text="历史原文").wait_for()
        await page.wait_for_function(
            "document.querySelector('#playerRefs img')?.naturalWidth===10"
        )
        assert await page.locator("#playerPrompt .mention").count() == 2
        assert await page.locator("#reuse").is_enabled()
        await page.locator("#reuse").click()
        await page.get_by_text("草稿已保存").wait_for()
        assert (
            await page.evaluate("snapshot().prompt")
            == "历史原文\n镜头朝向<Picture 1>，随后再次看向<Picture 1>。"
        )
        assert await page.locator("#duration").input_value() == "11"
        await page.evaluate(
            """()=>{const item=jobs.find(j=>j.id==='legacy');delete item.form;persist();}"""
        )
        await page.reload()
        await old.locator(".job-cover").click()
        await page.locator("#playerPrompt").filter(has_text="历史原文").wait_for()
        assert requested == ["legacy"]
        await page.locator("#closePlayer").click()
        await (
            page.locator(".job")
            .filter(has_text="服务器无历史记录")
            .locator(".job-cover")
            .click()
        )
        await page.get_by_text(
            "本地记录和 ComfyUI 历史中均没有可恢复的提示词。"
        ).wait_for()
        assert await page.locator("#reuse").is_disabled()
        assert await page.locator("#download").is_visible()
        assert requested == ["legacy", "missing"]
        assert not errors, errors
        await browser.close()
        print(
            f"PASS {path.name}: saved-record merge, nonblocking preview, legacy history/refs/parameters, reuse, recovery cached across reload, missing-history fallback"
        )


asyncio.run(main(html_path()))
