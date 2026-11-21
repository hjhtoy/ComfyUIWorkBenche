from support import html_path, launch_chromium
import asyncio
from playwright.async_api import async_playwright


async def verify(path):
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        page = await browser.new_page(viewport={"width": 1240, "height": 920})
        await page.route(
            "http://127.0.0.1:*/**",
            lambda r: r.fulfill(
                json={"queue_running": [], "queue_pending": []},
                headers={"Access-Control-Allow-Origin": "*"},
            ),
        )
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(path.resolve().as_uri())
        await page.evaluate("""()=>{
    const a='http://127.0.0.1:8188',b='http://127.0.0.1:8199';
    writeLocal(serverKey,[{id:'a',name:'服务器甲',url:a},{id:'b',name:'服务器乙',url:b}]);
    const records=[
      ['done','完成甲一',a],['failed','失败甲一',a],['queued','排队甲',a],
      ['done','完成甲二',a],['cancelled','取消甲',a],['lost','停止跟踪甲',a],
      ['running','运行甲',a],['done','完成乙',b]
    ].map(([state,title,base],i)=>({state,title,base,client:'fixture'+i,n:i+1,
          endedAt:states[state] && terminal({state})?i+1:null,form:{html:title,refs:[],server:base}}));
    sessionStorage.setItem(sessionKey,JSON.stringify(records));
  }""")
        await page.reload()
        tabs = page.get_by_role("tablist", name="任务状态")

        async def select(label):
            await tabs.get_by_role("tab", name=label, exact=True).click()
            assert (
                await tabs.get_by_role("tab", name=label, exact=True).get_attribute(
                    "aria-selected"
                )
                == "true"
            )

        async def shown():
            return await page.locator(".job:visible .job-name").evaluate_all(
                "nodes=>nodes.map(n=>n.title)"
            )

        async def counts():
            return await tabs.locator(".queue-tab-count").all_text_contents()

        assert len(await shown()) == 7
        assert await counts() == ["7", "2", "2", "1", "2"]
        await select("处理中")
        assert await shown() == ["运行甲", "排队甲"]
        await page.locator("#selectAllJobs").check()
        assert await page.locator("#selectedCount").inner_text() == "已选 2 条"
        assert await page.locator("#batchDelete").is_disabled()
        await select("已完成")
        assert await shown() == ["完成甲二", "完成甲一"]
        assert await page.locator("#selectedCount").inner_text() == ""
        await page.locator("#selectAllJobs").check()
        assert await page.locator(".job-check:checked").count() == 2
        await select("取消")
        assert await shown() == ["取消甲"]
        await tabs.get_by_role("tab", name="取消", exact=True).press("ArrowRight")
        assert await shown() == ["停止跟踪甲", "失败甲一"]
        assert await page.get_by_role("tabpanel", name="失败").is_visible()
        await tabs.get_by_role("tab", name="失败", exact=True).press("Home")
        assert len(await shown()) == 7
        await select("处理中")
        await page.evaluate("finish(jobs.find(j=>j.title==='运行甲'),'done','已结束')")
        assert await shown() == ["排队甲"]
        assert await page.locator("#jobCount").inner_text() == "01"
        assert await counts() == ["7", "1", "3", "1", "2"]
        await page.locator("#serverList").select_option(label="服务器乙")
        assert await shown() == []
        assert await page.get_by_text("暂无处理中的任务").is_visible()
        assert await counts() == ["1", "0", "1", "0", "0"]
        await select("已完成")
        assert await shown() == ["完成乙"]
        await page.locator("#serverList").select_option(label="服务器甲")
        assert await shown() == ["运行甲", "完成甲二", "完成甲一"]
        for theme in (
            "classic",
            "midnight",
            "blueprint",
            "editorial",
            "cinema",
            "lilac",
        ):
            await page.evaluate("theme=>applyTheme(theme)", theme)
            borders = await page.locator(".job:visible").evaluate_all("""rows=>rows.map(row=>{
     const s=getComputedStyle(row); return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth];
   })""")
            assert borders == [
                ["0px", "0px", "0px", "0px"],
                ["1px", "0px", "0px", "0px"],
                ["1px", "0px", "0px", "0px"],
            ], (theme, borders)
            await page.set_viewport_size({"width": 390, "height": 844})
            assert await page.evaluate(
                "document.documentElement.scrollWidth===innerWidth"
            )
            assert await tabs.get_by_role("tab").count() == 5
            await page.set_viewport_size({"width": 1240, "height": 920})
        await (
            page.locator(".job:visible")
            .filter(has_text="完成甲一")
            .get_by_role("button", name="删除", exact=True)
            .click()
        )
        await page.locator("#confirmDelete").click()
        assert await counts() == ["6", "1", "2", "1", "2"]
        assert not errors, errors
        await browser.close()
        print(
            f"PASS {path.name}: five filters, keyboard navigation, server scope, dynamic state, batch selection and horizontal-only dividers in all six themes"
        )


asyncio.run(verify(html_path()))
