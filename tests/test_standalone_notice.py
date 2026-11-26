"""Standalone builds must point to the hosted workspace without breaking legacy flows."""
import asyncio
import sys
import tempfile
from pathlib import Path

from aiohttp import web
from playwright.async_api import async_playwright

from support import ROOT, html_path, launch_chromium

sys.path.insert(0, str(ROOT))
from workspace.server import create_app


async def listen(app):
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"


async def verify(temp):
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        page = await browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_default_timeout(10000)
        await page.add_init_script(
            "window.open=(url)=>{window.__opened=url;return null;}"
        )
        await page.goto(html_path().as_uri())
        notice = page.locator("#standaloneNotice")
        await notice.wait_for(state="visible")
        assert (
            await page.locator("#workspaceUrl").input_value()
            == "http://127.0.0.1:8787"
        )
        # The banner export must reuse the legacy .ffdata exporter.
        async with page.expect_download() as download:
            await page.locator("#exportForWorkspace").click()
        archive = temp / "notice.ffdata"
        await (await download.value).save_as(archive)
        assert archive.read_bytes().startswith(b"FRAMEFORM-1\n")
        assert "migrate" in await page.locator("#standaloneStatus").inner_text()
        await page.locator("#workspaceUrl").fill("not-a-url")
        await page.locator("#openWorkspace").click()
        assert "有效" in await page.locator("#standaloneStatus").inner_text()
        assert await page.evaluate("window.__opened") is None
        await page.locator("#workspaceUrl").fill("http://127.0.0.1:8787/")
        await page.locator("#openWorkspace").click()
        assert await page.evaluate("window.__opened") == "http://127.0.0.1:8787/"
        await page.locator("#dismissStandalone").click()
        await notice.wait_for(state="hidden")
        await page.reload()
        await page.wait_for_function(
            "document.documentElement.dataset.workbenchReady==='true'"
        )
        assert not await notice.is_visible()
        # A fresh browser profile equals a new window or another machine.
        other = await browser.new_page()
        other.on("pageerror", lambda e: errors.append(str(e)))
        await other.goto(html_path().as_uri())
        await other.locator("#standaloneNotice").wait_for(state="visible")
        await other.close()
        await page.close()

        remote = web.Application()

        async def comfy(request):
            if request.path == "/queue":
                return web.json_response(dict(queue_running=[], queue_pending=[]))
            if request.path.startswith("/history"):
                return web.json_response({})
            return web.json_response({"system": {}, "devices": []})

        remote.router.add_route("*", "/{tail:.*}", comfy)
        cr, _ = await listen(remote)
        runner, url = await listen(
            create_app(temp / "hosted", ROOT / "dist" / "Frameform.html")
        )
        try:
            hosted_page = await browser.new_page()
            hosted_page.on("pageerror", lambda e: errors.append(str(e)))
            hosted_page.set_default_timeout(10000)
            await hosted_page.goto(url)
            await hosted_page.wait_for_function(
                "document.documentElement.dataset.workbenchReady==='true'"
            )
            assert not await hosted_page.locator("#standaloneNotice").is_visible()
            await hosted_page.close()
        finally:
            await runner.cleanup()
            await cr.cleanup()
        assert not errors, errors
        await browser.close()


with tempfile.TemporaryDirectory() as d:
    asyncio.run(verify(Path(d)))
print(
    "PASS: standalone notice, address validation, legacy export, "
    "dismissal memory, fresh-profile notice and hosted suppression"
)
