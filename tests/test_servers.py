from support import html_path, launch_chromium
import asyncio
from playwright.async_api import async_playwright


async def verify():
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context()
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        url = html_path().as_uri()
        await page.goto(url)
        await page.evaluate("""()=>localStorage.setItem('frameform.servers.v1',JSON.stringify([
    {id:'legacy-id', name:'原服务器', url:'http://127.0.0.1:8188'}
  ]))""")
        await page.reload()

        async def add(page, name, address):
            await page.locator("#manageServers").click()
            assert await page.locator("#saveServer").inner_text() == "新增地址"
            await page.locator("#serverName").fill(name)
            await page.locator("#serverURL").fill(address)
            await page.locator("#saveServer").click()
            await page.locator("#serversDialog").wait_for(state="hidden")

        await add(page, "同地址别名", "http://127.0.0.1:8188/")
        assert await page.locator("#serverList").input_value() != "legacy-id"
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert (
            await page.locator("#serverList option:checked").inner_text()
            == "同地址别名"
        )
        await add(page, "备用", "http://127.0.0.1:8199")
        assert await page.locator(
            '#serverList option[value]:not([value=""])'
        ).all_text_contents() == ["原服务器", "同地址别名", "备用"]
        await page.locator("#manageServers").click()
        await (
            page.locator(".saved-server")
            .filter(has_text="同地址别名")
            .get_by_role("button", name="编辑")
            .click()
        )
        assert await page.locator("#saveServer").inner_text() == "保存修改"
        await page.locator("#serverName").fill("办公室别名")
        await page.locator("#saveServer").click()
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert (
            await page.locator("#serverList option:checked").inner_text()
            == "办公室别名"
        )

        other = await context.new_page()
        await other.goto(url)
        await other.locator("#manageServers").click()
        await add(page, "工作室", "http://127.0.0.1:8200")
        await other.locator("#serverName").fill("渲染机")
        await other.locator("#serverURL").fill("http://127.0.0.1:8201")
        await other.locator("#saveServer").click()
        await page.locator("#serverList option", has_text="渲染机").wait_for(
            state="attached"
        )
        assert await page.locator("#serverList option").count() == 6

        await page.locator("#serverList").select_option(label="备用")
        assert await page.locator("#server").input_value() == "http://127.0.0.1:8199"
        await page.locator("#serverList").select_option(label="原服务器")
        assert await page.locator("#server").input_value() == "http://127.0.0.1:8188"
        await page.locator("#manageServers").click()
        await (
            page.locator(".saved-server")
            .filter(has_text="办公室别名")
            .get_by_role("button", name="移除")
            .click()
        )
        await page.locator("#closeServers").click()
        await page.reload()
        await page.get_by_text("草稿已保存").wait_for()
        assert await page.locator("#serverList option").all_text_contents() == [
            "已保存地址",
            "原服务器",
            "备用",
            "工作室",
            "渲染机",
        ]
        assert not errors, errors
        print(
            "PASS: existing entry, same-URL alias, distinct URLs, edit, cross-tab addition, removal, selection and refresh"
        )
        await browser.close()


asyncio.run(verify())
