from support import html_path, launch_chromium
import asyncio, io, base64
from PIL import Image
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context(viewport={"width": 1260, "height": 900})
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await context.route(
            "http://127.0.0.1:8188/**",
            lambda r: r.fulfill(
                json={"queue_running": [], "queue_pending": []},
                headers={"Access-Control-Allow-Origin": "*"},
            ),
        )
        url = html_path().as_uri()
        await page.goto(url)
        pic = io.BytesIO()
        Image.new("RGB", (8, 8), "orange").save(pic, format="PNG")
        await page.evaluate(
            """async data=>{
    const content=Uint8Array.from(atob(data),v=>v.charCodeAt(0));
    await fileData('image:fixture',new File([content],'参考图.png',{type:'image/png'}));
    const base='http://127.0.0.1:8188';
    const form={server:base,ratio:'9:16',duration:8,steps:10,mp:.56,
      html:'场景 '+mentionChip(1,'参考图.png').outerHTML+' 复用测试',refs:[{key:1,id:'fixture',name:'参考图.png'}]};
    const all=[
      {client:'failed',n:1,state:'failed',title:'失败示例',note:'采样节点报错',form},
      {client:'cancelled',n:2,state:'cancelled',title:'取消示例',note:'服务器已中断执行',form:{...form,html:'取消任务的原始提示词',refs:[],duration:12,steps:5}},
      {client:'ok',n:3,state:'done',title:'成功示例',form,id:'ok',results:[{kind:'video',filename:'video.mp4',subfolder:'Video',type:'output'}]},
      {client:'active',n:4,state:'running',title:'运行示例',sent:false,form}
    ].map(j=>({...j,base,endedAt:j.state==='running'?null:j.n}));
    writeLocal(historyKey,all.filter(terminal));
    sessionStorage.setItem(sessionKey,JSON.stringify(all));
  }""",
            base64.b64encode(pic.getvalue()).decode(),
        )
        await page.reload()
        composer = page.locator("#editor")
        await composer.fill("当前草稿")
        dialog = page.locator("#player")
        failed = page.locator(".job").filter(has_text="失败示例")
        await failed.get_by_role("button", name="查看任务详情 1 · 失败").click()
        await dialog.wait_for(state="visible")
        assert await composer.inner_text() == "当前草稿"
        assert await dialog.get_by_role("heading", name="失败", exact=True).count() == 1
        assert await dialog.get_by_text("采样节点报错", exact=True).count() == 1
        await page.wait_for_function(
            "document.querySelector('#playerRefs img')?.naturalWidth===8"
        )
        assert await dialog.locator("video").count() == 0
        assert await dialog.locator("#download").is_hidden()
        assert await dialog.get_by_role("button", name="同款参数创作").is_enabled()
        await dialog.get_by_role("button", name="同款参数创作").click()
        await dialog.wait_for(state="hidden")
        await page.get_by_text("草稿已保存", exact=True).wait_for()
        assert await page.evaluate("snapshot().prompt") == "场景 <Picture 1> 复用测试"
        assert await page.locator("#ratio").input_value() == "9:16"
        assert await page.locator("#size option:checked").inner_text() == "576 × 1024"
        assert await page.locator("#duration").input_value() == "8"
        assert await page.locator("#steps").input_value() == "10"
        await (
            page.locator(".job")
            .filter(has_text="取消示例")
            .locator(".job-name")
            .click()
        )
        await dialog.wait_for(state="visible")
        assert await dialog.get_by_role("heading", name="已取消").count() == 1
        assert await dialog.get_by_text("取消任务的原始提示词", exact=True).count() == 1
        assert await page.evaluate("snapshot().prompt") == "场景 <Picture 1> 复用测试"
        assert await page.locator("#duration").input_value() == "8"
        assert await page.locator("#steps").input_value() == "10"
        assert await dialog.locator("#download").is_hidden()
        assert await dialog.locator("video").count() == 0
        await dialog.locator("#reuse").click()
        await page.get_by_text("草稿已保存", exact=True).wait_for()
        assert await page.locator("#duration").input_value() == "12"
        assert await page.locator("#steps").input_value() == "5"
        await (
            page.locator(".job")
            .filter(has_text="成功示例")
            .locator(".job-cover")
            .click()
        )
        await dialog.locator("video").wait_for(state="attached")
        assert await dialog.locator("#download").is_visible()
        await dialog.locator("#closePlayer").click()
        await (
            page.locator(".job")
            .filter(has_text="运行示例")
            .locator(".job-name")
            .click()
        )
        assert await dialog.is_hidden()
        await page.get_by_role("button", name="查看任务详情 4 · 生成中").click()
        await dialog.get_by_role("heading", name="生成中", exact=True).wait_for()
        await dialog.locator("#playerPrompt").filter(has_text="复用测试").wait_for()
        assert await dialog.locator("#download").is_hidden()
        await page.evaluate("finish(jobs.find(j => j.client === 'active'), 'failed', '运行中断')")
        await dialog.get_by_role("heading", name="失败", exact=True).wait_for()
        assert await dialog.get_by_text("运行中断", exact=True).is_visible()
        assert await dialog.locator("#download").is_hidden()
        assert not errors, errors
        print(
            "PASS: task details, parameter reuse, and live preview through execution failure"
        )
        await browser.close()


asyncio.run(main())
