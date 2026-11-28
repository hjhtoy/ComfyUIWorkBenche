import asyncio
import base64
import contextlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import quote, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, web

from .folder_picker import choose_output_directory, picker_executable
from .store import Conflict, Store, backup, downloads_directory, ensure_dir
from .worker import TERMINAL, Worker, file_base, now, output_key, server_base

OUTPUTS_KEY = "frameform.outputs.v1"


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def create_app(root, html, host="127.0.0.1", password=None, outputs=None):
    if not loopback(host) and not password:
        raise ValueError("局域网访问需要设置 FRAMEFORM_PASSWORD")
    default_outputs = (
        Path(outputs).expanduser().resolve()
        if outputs
        else downloads_directory()
    )
    @web.middleware
    async def boundary(request, handler):
        if loopback(host) and not loopback(request.url.host):
            raise web.HTTPForbidden()
        if password:
            expected = "Basic " + base64.b64encode(("frameform:"+password).encode()).decode()
            if not hmac.compare_digest(request.headers.get("Authorization",""), expected):
                raise web.HTTPUnauthorized(headers={"WWW-Authenticate": 'Basic realm="Frameform"'})
        if request.method not in ("GET","HEAD"):
            origin = request.headers.get("Origin")
            if request.headers.get("X-Frameform") != "1" or (origin and urlsplit(origin).netloc != request.host):
                raise web.HTTPForbidden()
        try:
            response = await handler(request)
        except (ClientError, asyncio.TimeoutError) as e:
            return web.json_response({"error":"无法访问 ComfyUI 服务器。"+str(e)},status=502)
        except Conflict as e:
            return web.json_response({"error":str(e)},status=409)
        except (ValueError, KeyError, TypeError, IndexError) as e:
            return web.json_response({"error":str(e)},status=400)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'self'")
        return response

    app = web.Application(middlewares=[boundary], client_max_size=64*1024**2)
    store = Store(root)
    # Acquire the OS lock before starting a second sender for the same database.
    lock = (store.root/"worker.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        store.db.close()
        raise ValueError("此工作区已有服务在运行")

    async def lifecycle(_):
        nonlocal worker
        async with ClientSession(timeout=ClientTimeout(total=600, sock_connect=10, sock_read=120), trust_env=False) as http:
            worker = Worker(store,http,output_setting)
            task = asyncio.create_task(worker.run())
            try:
                yield
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                store.db.close()
                lock.close()
    worker = None
    app.cleanup_ctx.append(lifecycle)
    routes = web.RouteTableDef()
    directory_picker = asyncio.Lock()

    def output_record(workflow):
        record = store.record(OUTPUTS_KEY + "." + workflow)
        if workflow == "pika-h3" and not record["rev"]:
            record["value"] = store.record(OUTPUTS_KEY)["value"]
        return record

    def output_setting(workflow):
        value = output_record(workflow)["value"]
        return Path(value).expanduser() if isinstance(value, str) and value else default_outputs

    def local_desktop(request):
        return loopback(request.remote) and loopback(request.url.host)

    def output_response(request, workflow, record):
        return web.json_response({
            "outputs": str(output_setting(workflow)),
            "default": str(default_outputs),
            "configured": bool(record["value"]),
            "rev": record["rev"],
            "canChooseDirectory": bool(local_desktop(request) and picker_executable()),
        })

    @routes.get("/")
    @routes.get("/Frameform.html")
    async def index(request):
        state = json.dumps(store.records(),ensure_ascii=True).replace("<","\\u003c")
        marker = '<script id="frameformWorkspace" type="application/json">'+state+'</script>'
        page = html.read_text(encoding="utf-8").replace("<head>","<head>"+marker,1)
        return web.Response(text=page,content_type="text/html")

    @routes.get("/workspace/versions")
    async def versions(request):
        return web.json_response(dict(store.db.execute("SELECT key,rev FROM records")))

    @routes.get("/workspace/settings")
    async def get_settings(request):
        workflow = request.query.get("workflow", "pika-h3")
        return output_response(request, workflow, output_record(workflow))

    @routes.post("/workspace/settings/choose-directory")
    async def pick_directory(request):
        if not local_desktop(request):
            raise web.HTTPForbidden()
        if directory_picker.locked():
            raise Conflict("系统目录选择器已打开。")
        workflow = request.query.get("workflow", "pika-h3")
        async with directory_picker:
            path = await choose_output_directory(output_setting(workflow))
        return web.json_response({"path": str(path) if path else None})

    @routes.put("/workspace/settings")
    async def put_settings(request):
        data = await request.json()
        workflow = request.query.get("workflow", "pika-h3")
        raw = str(data.get("outputs") or "")
        if not raw.strip():
            raw = ""
        path = Path(raw).expanduser().resolve() if raw else default_outputs
        if path.exists() and not path.is_dir():
            raise ValueError("输出目录是一个文件，请选择文件夹。")
        try:
            ensure_dir(path)
        except OSError as error:
            raise ValueError("无法创建输出目录：" + str(error))
        record = store.put_record(OUTPUTS_KEY + "." + workflow, data.get("rev", 0), str(path) if raw else "")
        return output_response(request, workflow, record)

    @routes.get("/workspace/provider")
    async def get_provider(request):
        return web.json_response({"runninghub": bool(store.secret("runninghub"))})

    @routes.put("/workspace/provider")
    async def put_provider(request):
        data = await request.json()
        if data.get("clear"):
            store.clear_secret("runninghub")
            return web.json_response({"runninghub": False})
        key = str(data.get("runninghubApiKey") or "").strip()
        if not key:
            raise ValueError("请输入 RunningHub API Key")
        store.set_secret("runninghub", key)
        return web.json_response({"runninghub": True})

    @routes.get("/workspace/records")
    async def records(request):
        key = request.query.get("key")
        return web.json_response(store.record(key) if key else store.records())

    @routes.put("/workspace/records")
    async def put_record(request):
        record = await request.json()
        key = request.query["key"]
        return web.json_response(store.put_record(key,record["rev"],record["value"]))

    @routes.put("/workspace/media")
    async def put_media(request):
        key = request.query["key"]
        if not key.startswith(("material:","image:")):
            raise ValueError("素材编号无效")
        await store.save_stream(request.content,key,request.query["name"],request.content_type)
        return web.json_response({"saved": True})

    @routes.get("/workspace/media")
    async def get_media(request):
        row = store.media(request.query["key"])
        if not row:
            raise web.HTTPNotFound()
        return media_response(row)

    def media_response(row):
        return web.FileResponse(store.root/row["path"], headers={
            "Content-Type":row["mime"], "X-File-Name":quote(row["name"],safe=""),
            "Content-Disposition":"attachment", "Content-Security-Policy":"sandbox",
        })

    @routes.get("/workspace/result")
    async def result_media(request):
        job = store.job(request.query["client"])
        item = job["results"][int(request.query["index"])]
        row = store.media(output_key(job,item))
        if row:
            return media_response(row)
        from urllib.parse import urlencode
        path = "/view?"+urlencode({key:item[key] for key in ("filename","subfolder","type")})
        raise web.HTTPFound("/workspace/comfy?"+urlencode({"base":job["base"],"path":path}))

    @routes.get("/workspace/progress")
    async def progress(request):
        # Live node/step progress straight from ComfyUI's WebSocket stream.
        return web.json_response({"clients": worker.progress_snapshot()})

    @routes.get("/workspace/jobs")
    async def jobs(request):
        workflow = request.query["workflow"]
        if "since" not in request.query:
            return web.json_response(store.jobs(workflow))
        version = store.db.execute("SELECT rev FROM queue_versions WHERE workflow=?",(workflow,)).fetchone()
        revision = version[0] if version else 0
        rows = None if str(revision)==request.query["since"] else store.jobs(workflow)
        return web.json_response({"rev":revision, "rows":rows,
                                  "connection":getattr(worker,"connection","")})

    @routes.post("/workspace/jobs")
    async def add(request):
        data = await request.json()
        workflow = data["workflow"]
        with store.db:
            for record in data["jobs"]:
                job, plan = record["job"], record.get("plan")
                job["base"] = server_base(job["base"])
                if plan:
                    if not isinstance(plan["graph"],dict) or plan["workflow"] != workflow:
                        raise ValueError("工作流无效")
                    for ref in plan["inputs"]:
                        if not store.media(ref["key"]):
                            raise ValueError("任务引用了未入库的素材")
                    job.update(state="local", sent=False, note="已保存，等待提交")
                elif not (job.get("id") and job.get("imported")):
                    raise ValueError("缺少提交参数")
                elif store.db.execute("""
                    SELECT 1 FROM jobs WHERE workflow=? AND
                    json_extract(data,'$.base')=? AND
                    (client=? OR json_extract(data,'$.id')=?)
                """,(workflow,job["base"],job["id"],job["id"])).fetchone():
                    continue
                store.insert_job(workflow, job, plan)
        worker.wake.set()
        return web.json_response({"saved":True})

    @routes.post("/workspace/cancel")
    async def cancel(request):
        cid = (await request.json())["client"]
        job = store.job(cid)
        if job["state"] not in TERMINAL:
            if job["state"] in ("local","upload"):
                store.change(cid,state="cancelled",cancel=False,note="已在提交前取消",endedAt=now())
            else:
                store.change(cid,state="stopping",cancel=True,note="正在请求取消")
        return web.json_response({})

    @routes.post("/workspace/delete")
    @routes.post("/workspace/jobs/delete")
    async def delete(request):
        data = await request.json()
        clients = data["clients"]
        delete_files = data.get("deleteFiles", False)
        if type(delete_files) is not bool:
            raise ValueError("删除文件选项必须为布尔值")
        if not isinstance(clients, list) or any(not isinstance(cid, str) for cid in clients):
            raise ValueError("无效的任务编号")
        selected = []
        for cid in dict.fromkeys(clients):
            row = store.db.execute("SELECT workflow FROM jobs WHERE client=?", (cid,)).fetchone()
            if not row:
                continue
            job = store.job(cid)
            if job["state"] not in TERMINAL or job.get("archivePending"):
                raise Conflict("任务仍在执行或保存结果，请稍后删除。")
            selected.append((job, row["workflow"]))
        try:
            store.delete_jobs(selected, legacy_output_paths, delete_files=delete_files)
        except OSError as error:
            raise ValueError("无法删除结果文件：" + str(error)) from error
        return web.json_response({})

    def legacy_output_paths(job, workflow, item):
        directories = {output_setting(workflow), default_outputs, Path.cwd() / "outputs"}
        legacy = store.record(OUTPUTS_KEY)["value"]
        if isinstance(legacy, str) and legacy:
            directories.add(Path(legacy))
        suffix = Path(item["filename"]).suffix
        stem = file_base(job.get("title"))
        tag = file_base(str(job["client"])[:8])
        for directory in directories:
            yield directory / (stem + "-" + tag + suffix)
            # The original exporter hard-linked the unsuffixed name to the archive.
            yield directory / (stem + suffix)

    @routes.get("/workspace/comfy")
    async def proxy(request):
        base, path = server_base(request.query["base"]),request.query["path"]
        route = path.split("?",1)[0]
        if route not in ("/queue","/object_info","/system_stats","/view") and not (
                route.startswith("/history/") and "/" not in route[len("/history/"):] and ".." not in route):
            raise web.HTTPNotFound()
        async with worker.http.get(base+path,allow_redirects=False) as remote:
            if not 200 <= remote.status < 300:
                return web.Response(status=remote.status if remote.status>=400 else 502)
            result = web.StreamResponse(headers={"Content-Type":remote.content_type if route=="/view" else "application/json",
                                                 "X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"})
            await result.prepare(request)
            async for block in remote.content.iter_chunked(1024*1024):
                await result.write(block)
            return result

    @routes.get("/workspace/backup")
    async def download(request):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)/"workspace.zip"
            await asyncio.to_thread(backup,store.root,target)
            result = web.StreamResponse(headers={"Content-Type":"application/zip","Content-Disposition":'attachment; filename="Frameform-workspace.zip"',"Content-Length":str(target.stat().st_size)})
            await result.prepare(request)
            with target.open("rb") as f:
                while block := f.read(1024*1024):
                    await result.write(block)
            return result

    app.add_routes(routes)
    return app
