"""Replace a legacy entry in place and exercise the production bundle."""

import asyncio
import os
from pathlib import Path
import tempfile

from playwright.async_api import async_playwright

from support import ROOT, launch_chromium


async def verify():
    previous_release = os.environ.get("FRAMEFORM_PREVIOUS_HTML")
    with tempfile.TemporaryDirectory() as temp:
        entry = Path(temp) / "老工作台" / "Frameform.html"
        entry.parent.mkdir()
        if previous_release:
            entry.write_bytes(Path(previous_release).read_bytes())
        else:
            entry.write_text("<!doctype html><meta charset=utf-8>")
        url = entry.as_uri()
        async with async_playwright() as playwright:
            browser = await launch_chromium(playwright)
            page = await browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))

            async def comfy(route):
                path = route.request.url
                cors = {"Access-Control-Allow-Origin": "*"}
                if path.endswith("/queue"):
                    await route.fulfill(
                        json={
                            "queue_running": [],
                            "queue_pending": [
                                [
                                    1,
                                    "legacy-pending",
                                    {},
                                    {"client_id": "legacy-client"},
                                ]
                            ],
                        },
                        headers=cors,
                    )
                else:
                    await route.fulfill(json={}, headers=cors)

            await page.route("http://127.0.0.1:*/**", comfy)
            await page.goto(url)
            await page.evaluate("""async () => {
              const primary = 'http://127.0.0.1:8188';
              const secondary = 'http://127.0.0.1:8199';
              const path = location.pathname;
              const ref = { id:'legacy-image', key:1, name:'旧参考.png', kind:'image' };
              const form = {
                html:'旧草稿 <span class="mention" data-key="1">旧参考.png</span>',
                refs:[ref], server:secondary, serverProfileId:'studio', ratio:'9:16',
                mp:0.56, duration:8, steps:11, height:'174px'
              };
              const done = {
                n:1, base:secondary, client:'legacy-done', id:'legacy-done',
                state:'done', title:'旧任务', sent:true, endedAt:1,
                form:{...form, html:'旧任务提示词'},
                results:[{kind:'video', filename:'legacy.webm', subfolder:'Video', type:'output'}]
              };
              const tombstone = { ...done, n:2, client:'deleted', id:'deleted', title:'已删除任务' };
              const active = {
                n:3, base:secondary, client:'legacy-client', id:'legacy-pending',
                state:'queued', title:'刷新前的活动任务', sent:true, form
              };
              const put = (key, value) => localStorage.setItem(key,JSON.stringify(value));
              localStorage.setItem('frameform.server',secondary);
              put('frameform.servers.v1',[
                {id:'primary',name:'主服务器',url:primary},
                {id:'studio',name:'工作室',url:secondary}
              ]);
              put('frameform.theme.v1','blueprint');
              put('frameform.video.v1',{cache:true});
              put('frameform.draft.v1.'+path,form);
              put('frameform.material-library.v1.'+path,[ref]);
              put('frameform.history.v2.'+path,[done,tombstone]);
              put('frameform.deleted-jobs.v1.'+path,['deleted']);
              sessionStorage.setItem('frameform.jobs.v1',JSON.stringify([active,done,tombstone]));
              const image = new Uint8Array(await (await fetch(
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD14AAAAASUVORK5CYII='
              )).arrayBuffer());
              await new Promise((resolve,reject) => {
                const request = indexedDB.open('frameform-local',1);
                request.onupgradeneeded = () => request.result.createObjectStore('files');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  const db = request.result;
                  const tx = db.transaction('files','readwrite');
                  const files = tx.objectStore('files');
                  files.put(new File([image],ref.name,{type:'image/png'}),'image:'+ref.id);
                  files.put(new Blob(['offline'],{type:'video/webm'}),
                    'output:'+secondary+':legacy-done:legacy.webm:Video');
                  tx.oncomplete = () => { db.close(); resolve(); };
                  tx.onerror = () => reject(tx.error);
                };
              });
            }""")
            entry.write_bytes((ROOT / "dist/Frameform.html").read_bytes())
            await page.reload()
            await page.get_by_text("草稿已保存", exact=True).wait_for()
            assert not await page.evaluate("typeof window.snapshot === 'function'")
            assert await page.locator("#editor").inner_text() == "旧草稿 旧参考.png"
            assert (
                await page.locator("#editor").evaluate("node => node.style.height")
                == "174px"
            )
            assert await page.locator("#ratio").input_value() == "9:16"
            assert (
                await page.locator("#size option:checked").inner_text() == "576 × 1024"
            )
            assert await page.locator("#duration").input_value() == "8"
            assert await page.locator("#steps").input_value() == "11"
            assert await page.locator("html").get_attribute("data-theme") == "blueprint"
            assert await page.locator("#serverList option").all_text_contents() == [
                "已保存地址",
                "主服务器",
                "工作室",
            ]
            assert await page.locator("#serverList").input_value() == "studio"
            await page.locator(".job-name", has_text="刷新前的活动任务").wait_for()
            assert await page.locator(".job-name", has_text="已删除任务").count() == 0
            await page.locator("#openSettings").click()
            await page.locator("#pickDirectory").wait_for(state="visible")
            await page.locator("#closeSettings").click()
            await page.locator("#addRef").click()
            await page.get_by_role("button", name="未分类", exact=True).click()
            await page.locator(".material-thumb", has_text="旧参考.png").wait_for()
            await page.locator("#closePicker").click()
            await page.locator(".job", has_text="旧任务").locator(".job-cover").click()
            await page.get_by_text("旧任务提示词", exact=True).wait_for()
            video = page.locator("#playerStage video")
            await video.wait_for()
            assert (await video.get_attribute("src")).startswith("blob:")
            assert not errors, errors
            await browser.close()
    print(
        "PASS: in-place upgrade restores legacy draft, profiles, settings, assets and jobs."
    )


asyncio.run(verify())
