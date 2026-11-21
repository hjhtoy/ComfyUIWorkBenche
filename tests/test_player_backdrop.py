from support import html_path, launch_chromium
import asyncio
from playwright.async_api import async_playwright


async def check(path):
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        await context.route(
            "http://127.0.0.1:8188/**",
            lambda r: r.fulfill(
                json={"queue_running": []}, headers={"Access-Control-Allow-Origin": "*"}
            ),
        )
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(path.resolve().as_uri())
        await page.evaluate("""()=>{
    const base='http://127.0.0.1:8188';
    writeLocal(historyKey,[{base,n:1,client:'fixture',title:'详情测试',state:'cancelled',note:'已中断',
      form:{html:'保留的提示词',refs:[],server:base},endedAt:1}]);
    writeLocal(serverKey,[{id:'fixture',name:'已有服务器',url:base}]);
  }""")
        await page.reload()

        async def warn(selector):
            assert (
                await page.locator(selector).evaluate("el=>getComputedStyle(el).color")
                == "rgb(162, 54, 36)"
            ), selector

        for selector in [
            "#closePicker",
            "#closePlayer",
            "#closeServers",
            "#closeSettings",
            "#batchDelete",
            "#confirmDelete",
            "#deleteTitle",
            "#deleteMessage",
            ".job-act button.danger",
        ]:
            await warn(selector)
        await page.locator("#manageServers").click()
        await warn(".saved-server button.danger")
        await page.locator("#closeServers").click()
        cover = page.locator(".job-cover")
        dialog = page.locator("#player")
        await cover.click()
        await page.locator("#playerPrompt").filter(has_text="保留的提示词").click()
        assert await dialog.is_visible()
        inside = await page.locator("#playerPrompt").bounding_box()
        await page.mouse.move(
            inside["x"] + inside["width"] / 2, inside["y"] + inside["height"] / 2
        )
        await page.mouse.down()
        await page.mouse.move(3, 3)
        await page.mouse.up()
        assert await dialog.is_visible()
        await page.mouse.click(3, 3)
        await dialog.wait_for(state="hidden")
        await cover.click()
        await page.keyboard.press("Escape")
        await dialog.wait_for(state="hidden")
        await cover.click()
        await page.locator("#closePlayer").click()
        await dialog.wait_for(state="hidden")
        await page.set_viewport_size({"width": 390, "height": 844})
        await cover.click()
        await page.mouse.click(2, 2)
        await dialog.wait_for(state="hidden")
        await (
            page.locator(".job-act")
            .get_by_role("button", name="删除", exact=True)
            .click()
        )
        assert await page.locator("#deleteMessage").is_visible()
        await page.locator("#confirmDelete").click()
        await page.get_by_text("已删除 1 条任务记录", exact=True).wait_for()
        await warn("#queueNotice")
        assert not errors, errors
        print(
            f"PASS {path.name}: backdrop dismiss, interior click and drag preserve dialog, keyboard/close action, mobile, warning-colored delete/remove/close text and confirmation"
        )
        await browser.close()


asyncio.run(check(html_path()))
