from support import html_path, launch_chromium
import asyncio
from playwright.async_api import async_playwright


async def main(path):
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        context = await browser.new_context(viewport={"width": 1380, "height": 900})
        page = await context.new_page()
        errors = []
        queries = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        a, b = "http://127.0.0.1:8188", "http://127.0.0.1:8199"
        data = {a: [], b: []}
        history = {}

        async def route(r):
            url = r.request.url
            base = url.split("/queue")[0]
            cors = {"Access-Control-Allow-Origin": "*"}
            if url.endswith("/queue"):
                queries.append(base)
                return await r.fulfill(
                    json={"queue_running": data.get(base, []), "queue_pending": []},
                    headers=cors,
                )
            if "/history/" in url:
                return await r.fulfill(json=history, headers=cors)
            return await r.fulfill(status=404, headers=cors)

        await context.route("http://127.0.0.1:*/**", route)
        await page.goto(path.resolve().as_uri())
        graphs = await page.evaluate(
            """([a,b])=>{
     writeLocal(serverKey, [{id:'a',name:'服务器甲',url:a},{id:'b',name:'服务器乙',url:b}]);
     writeLocal(historyKey,[
       {client:'a-old',id:'a-old',n:1,base:a,state:'done',title:'甲历史任务',form:{html:'甲提示词',refs:[],server:a},endedAt:1},
       {client:'b-old',id:'b-old',n:2,base:b,state:'done',title:'乙历史任务',form:{html:'乙提示词',refs:[],server:b},endedAt:2}
     ]);
     return ['甲运行中','乙运行中'].map(prompt=>buildGraph({prompt,ratio:'16:9',mp:.98,duration:12,steps:6},[]));
  }""",
            [a, b],
        )
        data[a] = [[0, "a-run", graphs[0], {}]]
        data[b] = [[0, "b-run", graphs[1], {}]]
        await page.reload()
        await page.get_by_text("已载入 1 条服务器任务").wait_for()
        assert await page.locator(".job:visible").count() == 2
        assert await page.locator(".job").filter(has_text="乙历史任务").is_hidden()
        await page.locator("#selectAllJobs").check()
        assert await page.locator("#selectedCount").inner_text() == "已选 2 条"
        await page.locator("#serverList").select_option(label="服务器乙")
        await page.locator(".job").filter(has_text="乙运行中").wait_for()
        assert b in queries
        assert await page.locator(".job:visible").count() == 2
        assert await page.locator("#selectedCount").inner_text() == ""
        assert await page.locator(".job").filter(has_text="甲历史任务").is_hidden()
        data[a] = []
        history["a-run"] = {
            "status": {"completed": True, "status_str": "success"},
            "outputs": {
                "152": {"gifs": [{"filename": "result.mp4", "type": "output"}]}
            },
        }
        await page.wait_for_function("jobs.find(j=>j.id==='a-run')?.state==='done'")
        await page.locator("#server").fill(a + "/")
        await page.locator("#server").press("Enter")
        assert await page.locator(".job").filter(has_text="甲运行中").is_visible()
        assert (
            "已完成"
            in await page.locator(".job").filter(has_text="甲运行中").inner_text()
        )
        assert await page.locator(".job").filter(has_text="乙运行中").is_hidden()
        assert await page.locator("#jobCount").inner_text() == "02"
        assert await page.evaluate("jobs.length") == 4

        prompt = page.locator("#editor")
        await prompt.fill("切换主题要保留的提示词")
        await page.locator("#steps").fill("13")
        await page.locator("#duration").fill("17")
        await page.locator("#size").select_option(label="1024 × 576")
        original = await page.evaluate(
            """()=>({...snapshot().form,html:editor.innerText})"""
        )
        colors = {}
        themes = ("classic", "midnight", "blueprint", "editorial", "cinema", "lilac")
        for theme in themes:
            await page.locator("#openSettings").click()
            await page.locator(f'.theme-choice[data-swatch="{theme}"]').click()
            assert await page.locator(
                f'#themeSettings input[value="{theme}"]'
            ).is_checked()
            await page.locator("#closeSettings").click()
            assert await page.locator("html").get_attribute("data-theme") == theme
            colors[theme] = await page.locator("body").evaluate(
                "el=>getComputedStyle(el).backgroundColor"
            )
            assert (
                await page.evaluate(
                    """()=>({...snapshot().form,html:editor.innerText})"""
                )
                == original
            )
            assert await page.locator(".job:visible").count() == 2
        assert len(set(colors.values())) == 6, colors
        await page.reload()
        await page.get_by_text("草稿已保存", exact=True).wait_for()
        assert await page.locator("html").get_attribute("data-theme") == "lilac"
        assert await page.locator(".job:visible").count() == 2
        assert await prompt.inner_text() == "切换主题要保留的提示词"
        for theme in themes:
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.locator("#openSettings").click()
            await page.locator(f'.theme-choice[data-swatch="{theme}"]').click()
            await page.locator("#closeSettings").click()
            assert await page.evaluate(
                "document.documentElement.scrollWidth===innerWidth"
            )
            for id in ["generate", "server", "queue", "steps", "duration"]:
                assert await page.locator("#" + id).is_visible()
        assert not errors, errors
        print(
            f"PASS {path.name}: server-isolated queue, refetch on dropdown/manual switch, background tracking, selection reset, six themes with draft intact, persisted theme, narrow viewport"
        )
        await browser.close()


asyncio.run(main(html_path()))
