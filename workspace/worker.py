import asyncio
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import aiohttp
from .store import downloads_directory, output_key

TERMINAL = {"done", "failed", "cancelled", "lost"}
# A server that stays unreachable this long cannot still hold these jobs: their
# in-memory queue is gone, so keep retrying only buys a permanent error banner.
CONN_GIVE_UP = 600
RUNNINGHUB_HOSTS = {"runninghub.cn", "www.runninghub.cn", "runninghub.ai", "www.runninghub.ai"}


def is_runninghub(base):
    try:
        return (urlsplit(base).hostname or "").lower() in RUNNINGHUB_HOSTS
    except ValueError:
        return False


def job_provider(job):
    return job.get("provider") or ("runninghub" if is_runninghub(job.get("base", "")) else "comfyui")


def server_base(value):
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("ComfyUI 地址无效")
    return value.rstrip("/")


def now():
    return int(time.time() * 1000)


def readable_error(raw):
    """Turn a ComfyUI validation body into one line a task card can show."""
    text = str(raw or "").strip()
    try:
        data = json.loads(text)
    except ValueError:
        return text[:400]
    if not isinstance(data, dict):
        return text[:400]
    parts = []
    for node, info in list((data.get("node_errors") or {}).items())[:3]:
        for item in (info.get("errors") or [])[:2]:
            detail = item.get("details") or item.get("message") or ""
            if detail:
                parts.append("节点 " + str(node) + "：" + str(detail))
    error = data.get("error")
    message = error.get("message") if isinstance(error, dict) else ""
    if parts:
        return ((message + "；" if message else "") + "；".join(parts))[:400]
    return (message or text)[:400]


def results(outputs, allowed=None):
    found = {}
    for node, groups in outputs.items():
        if allowed is not None and node not in allowed:
            continue
        for group, items in (groups or {}).items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("filename"), str):
                    continue
                name = item["filename"]
                ext = Path(name).suffix.lower()
                kind = "video" if ext in {".webm",".mp4",".mov",".mkv",".avi",".m4v"} or str(item.get("format")).startswith("video/") else "audio" if ext in {".wav",".mp3",".ogg",".flac",".m4a"} else "image" if group == "images" or ext in {".jpeg",".jpg",".png",".webp",".gif",".avif",".bmp"} else None
                if kind:
                    folder, typ = item.get("subfolder",""), item.get("type","output")
                    found[(name,folder,typ)] = dict(filename=name, subfolder=folder, type=typ, kind=kind)
    return sorted(found.values(), key=lambda x: x["kind"] != "video")


def file_base(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or ""))
    name = re.sub(r"\s+", " ", name).strip()
    name = re.sub(
        r"\.(?:png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov|m4v|mkv|avi|wav|mp3|ogg|flac)$",
        "",
        name,
        flags=re.IGNORECASE,
    )
    return name[:80].strip(" .") or "任务"


def runninghub_results(items):
    found = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = item.get("fileUrl")
        if not isinstance(url, str) or not url:
            continue
        name = urlsplit(url).path.rsplit("/", 1)[-1] or "output"
        ext = Path(name).suffix.lower()
        kind = (
            "video" if ext in {".mp4",".webm",".mov",".mkv",".avi",".m4v"}
            else "audio" if ext in {".wav",".mp3",".ogg",".flac",".m4a"}
            else "image"
        )
        found.append({"filename": name, "subfolder": "", "type": "output",
                      "kind": kind, "fileUrl": url})
    return sorted(found, key=lambda item: item["kind"] != "video")


class Worker:
    def __init__(self, store, session, outputs=None):
        self.store = store
        self.http = session
        self.outputs = outputs or (lambda _workflow: downloads_directory())
        self.tasks = {}
        self.sending = asyncio.Lock()
        self.uploads = {}
        self.wake = asyncio.Event()
        # A recent connection failure, shown once in the queue instead of on every job.
        self.connection = ""
        # base -> when it first became unreachable, so stale addresses stop retrying.
        self.unreachable = {}
        # Live node/step progress from ComfyUI's WebSocket, keyed by client id.
        self.progress = {}
        self.watchers = {}
        self.labels = {}
        self.prompt_ids = {}

    async def run(self):
        # Older versions stored connection failures on every job; clear them once.
        with self.store.db:
            self.store.db.execute("""UPDATE jobs SET data=json_set(data,'$.warn','')
                WHERE json_extract(data,'$.warn') LIKE '%Cannot connect%'""")
        try:
            while True:
                active = self.store.db.execute("""SELECT client FROM jobs WHERE
                    json_extract(data,'$.state') NOT IN ('done','failed','cancelled','lost')
                    OR json_extract(data,'$.archivePending')=1 ORDER BY n""").fetchall()
                if not active:
                    self.connection = ""
                for (cid,) in active:
                    if cid in self.tasks:
                        continue
                    task = asyncio.create_task(self.follow(cid))
                    self.tasks[cid] = task
                    task.add_done_callback(lambda _, key=cid: self.tasks.pop(key, None))
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), 2)
                except asyncio.TimeoutError:
                    pass
        finally:
            for task in self.tasks.values():
                task.cancel()
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def follow(self, cid):
        while True:
            try:
                job = self.store.job(cid)
                state = job["state"]
                if value := self.progress.get(cid):
                    if time.time() - value.get("at", 0) > 600:
                        self.progress.pop(cid, None)
                if job.get("archivePending"):
                    if job_provider(job) == "runninghub":
                        await self.archive_runninghub(job)
                    else:
                        await self.archive(job)
                elif state in TERMINAL:
                    self.stop_watcher(cid)
                    return
                elif state in ("local", "upload"):
                    async with self.sending:
                        if self.store.job(cid)["state"] in ("local","upload"):
                            await self.submit(job)
                elif job_provider(job) == "runninghub":
                    await self.poll_runninghub(job)
                else:
                    await self.poll(job)
                # Only running jobs need a socket: one per active server.
                if state == "running":
                    self.ensure_watcher(job)
                self.connection = ""
                self.unreachable.pop(job.get("base", ""), None)
            except KeyError as e:
                # Only a missing job ends tracking; unexpected shapes must retry.
                try:
                    self.store.job(cid)
                except KeyError:
                    return
                self.store.change(cid, warn="工作区将重试：" + str(e))
                await asyncio.sleep(4)
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
                # Keep transport errors off the job cards; recovery is automatic.
                base = job.get("base", "")
                since = self.unreachable.setdefault(base, time.monotonic())
                if time.monotonic() - since >= CONN_GIVE_UP:
                    # Long-dead server: nothing to reconcile with any more. Stop
                    # tracking so one stale address cannot pin the queue banner.
                    self.unreachable.pop(base, None)
                    self.stop_watcher(cid)
                    self.store.change(
                        cid, state="lost", endedAt=now(), warn="", cancel="",
                        note="无法连接服务器 " + base + "，已停止跟踪；请确认地址后重新提交",
                    )
                    return
                self.connection = "无法访问 " + (base or "ComfyUI 服务器") + "，正在自动重试：" + str(e)
                await asyncio.sleep(4)
            except ValueError as e:
                self.store.change(cid, warn="工作区将重试：" + str(e))
                await asyncio.sleep(4)
            await asyncio.sleep(1)

    async def json(self, base, path, method="GET", **kwargs):
        async with self.http.request(method, base+path, allow_redirects=False, **kwargs) as r:
            raw = await r.text()
            if not 200 <= r.status < 300:
                raise aiohttp.ClientResponseError(r.request_info, r.history, status=r.status, message=readable_error(raw))
            return json.loads(raw or "{}")

    def ensure_watcher(self, job):
        """Listen on ComfyUI's WebSocket for the job's live node/step progress."""
        cid = job["client"]
        if cid in self.watchers or job_provider(job) != "comfyui":
            return
        task = asyncio.create_task(self.watch(cid, job.get("base", "")))
        self.watchers[cid] = task
        task.add_done_callback(lambda _, key=cid: self.watchers.pop(key, None))

    def stop_watcher(self, cid):
        task = self.watchers.pop(cid, None)
        if task:
            task.cancel()
        self.progress.pop(cid, None)
        self.labels.pop(cid, None)
        self.prompt_ids.pop(cid, None)

    async def watch(self, cid, base):
        # Events are routed to the client id used at submission time.
        url = base.replace("https://", "wss://").replace("http://", "ws://")
        url = url.rstrip("/") + "/ws?clientId=" + quote(cid)
        try:
            async with self.http.ws_connect(url, heartbeat=25, timeout=12) as socket:
                async for message in socket:
                    if message.type != aiohttp.WSMsgType.TEXT:
                        return
                    try:
                        payload = json.loads(message.data)
                    except ValueError:
                        continue
                    self.note_progress(cid, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Progress is a nicety: queue and history polling still drive state.
            return

    def prompt_id_of(self, cid):
        if cid not in self.prompt_ids:
            try:
                self.prompt_ids[cid] = str(self.store.job(cid).get("id") or "")
            except KeyError:
                return ""
        return self.prompt_ids[cid]

    def node_label(self, cid, node):
        labels = self.labels.get(cid)
        if labels is None:
            labels = {}
            row = self.store.db.execute(
                "SELECT plan FROM jobs WHERE client=?", (cid,)
            ).fetchone()
            if row and row[0]:
                for key, entry in (json.loads(row[0]).get("graph") or {}).items():
                    meta = entry.get("_meta") or {}
                    labels[str(key)] = (
                        meta.get("title") or entry.get("class_type") or "节点 " + str(key)
                    )
            self.labels[cid] = labels
        return labels.get(str(node)) or "节点 " + str(node)

    def note_progress(self, cid, message):
        kind = message.get("type")
        data = message.get("data") or {}
        prompt = data.get("prompt_id")
        if prompt and prompt != cid and prompt != self.prompt_id_of(cid):
            return
        stamp = time.time()
        if kind == "execution_start":
            self.progress[cid] = {"label": "开始执行", "value": None, "max": None, "at": stamp}
        elif kind == "executing":
            node = data.get("node")
            if node is None:
                self.progress.pop(cid, None)
                return
            self.progress[cid] = {
                "label": self.node_label(cid, node),
                "value": None,
                "max": None,
                "at": stamp,
            }
        elif kind == "progress":
            value, maximum = data.get("value"), data.get("max")
            if not isinstance(value, int) or not isinstance(maximum, int) or maximum <= 0:
                return
            node = data.get("node")
            label = self.node_label(cid, node) if node is not None else None
            self.progress[cid] = {
                "label": label or (self.progress.get(cid) or {}).get("label") or "生成中",
                "value": value,
                "max": maximum,
                "at": stamp,
            }
        elif kind in ("execution_success", "execution_error", "execution_interrupted"):
            self.progress.pop(cid, None)

    def progress_snapshot(self):
        cutoff = time.time() - 600
        return {
            cid: value
            for cid, value in self.progress.items()
            if value.get("at", 0) >= cutoff
        }

    async def submit(self, job):
        if job_provider(job) == "runninghub":
            return await self.submit_runninghub(job)
        cid, base = job["client"], job["base"]
        plan = json.loads(self.store.db.execute("SELECT plan FROM jobs WHERE client=?", (cid,)).fetchone()[0])
        self.store.change(cid, state="upload", note="工作区正在准备素材")
        try:
            for ref in plan["inputs"]:
                row = self.store.media(ref["key"])
                cache_key = (base,plan["batch"],row["path"],row["name"])
                path = self.uploads.get(cache_key)
                if not path:
                    with (self.store.root/row["path"]).open("rb") as source:
                        data = aiohttp.FormData()
                        data.add_field("type", "input")
                        data.add_field("subfolder", "frameform")
                        data.add_field("image", source, filename=row["name"], content_type=row["mime"])
                        saved = await self.json(base, "/upload/image", "POST", data=data)
                    path = "/".join(filter(None, [saved.get("subfolder"),saved["name"]]))
                    if len(self.uploads) >= 4096:
                        self.uploads.clear()
                    self.uploads[cache_key] = path
                for node, field in ref["fields"]:
                    plan["graph"][node]["inputs"][field] = path
            if self.store.job(cid)["state"] == "cancelled":
                return
            # A crash after this commit must reconcile with ComfyUI, never POST twice.
            self.store.change(cid, sent=True, state="sending", note="正在提交任务", warn="",
                              submittedAt=now())
            reply = await self.json(base, "/prompt", "POST", json={
                "prompt": plan["graph"], "client_id": cid, "prompt_id": cid,
                "extra_data": {"frameform_workflow_id": plan["workflow"]},
            })
            # Some gateways accept the POST but answer with an empty object; the
            # job is then tracked by client id instead of a returned prompt id.
            result = reply or {}
            prompt_id = result.get("prompt_id") or result.get("taskId") or result.get("task_id")
            changes = {
                "state": "queued",
                "note": "服务器排队" if prompt_id else "已提交，等待服务器确认",
                "submittedAt": now(),
                "warn": "",
            }
            if prompt_id:
                changes["id"] = str(prompt_id)
            self.store.change(cid, **changes)
        except aiohttp.ClientConnectorError:
            # No TCP connection was established, so the POST could not have reached ComfyUI.
            latest = self.store.job(cid)
            if latest.get("cancel") or latest["state"]=="cancelled":
                self.store.change(cid,state="cancelled",endedAt=now(),note="已在提交前取消")
            else:
                self.store.change(cid,sent=False,state="local",note="等待连接服务器")
            raise
        except aiohttp.ClientResponseError as e:
            if 400 <= e.status < 500 and e.status != 408:
                self.store.change(cid, state="failed", note=e.message, endedAt=now())
            else:
                raise

    def runninghub_key(self):
        return self.store.secret("runninghub")

    async def runninghub(self, base, path, payload):
        reply = await self.json(
            base, path, "POST", json=payload,
            headers={"Authorization": "Bearer " + str(payload.get("apiKey") or "")},
        )
        code = (reply or {}).get("code")
        if code not in (0, "0", None):
            raise ValueError((reply or {}).get("msg") or "RunningHub 请求失败")
        return (reply or {}).get("data")

    async def upload_runninghub(self, base, api_key, row):
        data = aiohttp.FormData()
        data.add_field("apiKey", api_key)
        data.add_field("fileType", "input")
        with (self.store.root / row["path"]).open("rb") as source:
            data.add_field("file", source, filename=row["name"], content_type=row["mime"])
            reply = await self.json(
                base, "/task/openapi/upload", "POST", data=data,
                headers={"Authorization": "Bearer " + api_key},
            )
        if (reply or {}).get("code") not in (0, "0", None):
            raise ValueError((reply or {}).get("msg") or "RunningHub 素材上传失败")
        name = ((reply or {}).get("data") or {}).get("fileName")
        if not name:
            raise ValueError("RunningHub 未返回素材文件名")
        return name

    async def submit_runninghub(self, job):
        cid, base = job["client"], job["base"]
        api_key = self.runninghub_key()
        if not api_key:
            self.store.change(cid, state="failed", note="未配置 RunningHub API Key", endedAt=now())
            return
        plan = json.loads(
            self.store.db.execute("SELECT plan FROM jobs WHERE client=?", (cid,)).fetchone()[0]
        )
        workflow_id = str(plan.get("runninghubWorkflowId") or "").strip()
        self.store.change(cid, state="upload", note="正在上传素材到 RunningHub")
        try:
            for ref in plan.get("inputs") or []:
                row = self.store.media(ref["key"])
                if not row:
                    raise ValueError("任务引用了未入库的素材")
                cache_key = (base, plan.get("batch"), row["path"], row["name"])
                name = self.uploads.get(cache_key)
                if not name:
                    name = await self.upload_runninghub(base, api_key, row)
                    if len(self.uploads) >= 1024:
                        self.uploads.clear()
                    self.uploads[cache_key] = name
                for node, field in ref.get("fields") or []:
                    inputs = plan["graph"].setdefault(node, {}).setdefault("inputs", {})
                    inputs[field] = name
                    for item in plan.get("nodeInfoList") or []:
                        if item.get("nodeId") == node and item.get("fieldName") == field:
                            item["fieldValue"] = name
        except aiohttp.ClientError:
            # Nothing was submitted yet, so the job can retry from the start.
            self.store.change(cid, state="local", note="等待连接 RunningHub")
            raise
        if self.store.job(cid)["state"] == "cancelled":
            return
        self.store.change(cid, sent=True, state="sending", note="正在提交任务", warn="",
                          submittedAt=now())
        payload = {"apiKey": api_key, "nodeInfoList": plan.get("nodeInfoList") or []}
        if workflow_id:
            payload["workflowId"] = workflow_id
        else:
            payload["workflow"] = json.dumps(plan["graph"], ensure_ascii=False)
        data = await self.runninghub(base, "/task/openapi/create", payload)
        task_id = data.get("taskId") if isinstance(data, dict) else None
        if not task_id:
            self.store.change(cid, state="failed", note="RunningHub 未返回任务编号", endedAt=now())
            return
        self.store.change(cid, id=str(task_id), state="queued", note="云端排队",
                          submittedAt=now(), warn="")

    async def poll_runninghub(self, job):
        cid, base = job["client"], job["base"]
        api_key = self.runninghub_key()
        task_id = job.get("id")
        if not api_key or not task_id:
            self.store.change(cid, warn="缺少 RunningHub 任务信息")
            return
        if job.get("cancel") and not job.get("cancelAck"):
            try:
                await self.runninghub(
                    base, "/task/openapi/cancel", {"apiKey": api_key, "taskId": task_id}
                )
            except (aiohttp.ClientError, ValueError):
                pass
            self.store.change(cid, cancelAck=True)
        data = await self.runninghub(
            base, "/task/openapi/outputs", {"apiKey": api_key, "taskId": task_id}
        )
        if isinstance(data, list):
            items = runninghub_results(data)
            if items:
                self.store.change(cid, state="done", endedAt=now(), results=items,
                                  archivePending=True, note="已生成",
                                  mediaNote="正在保存到工作区", warn="")
            else:
                self.store.change(cid, state="failed", endedAt=now(),
                                  note="任务完成但没有返回文件", warn="")
            return
        if isinstance(data, dict):
            status = str(data.get("taskStatus") or data.get("status") or "").upper()
            if status in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
                reason = data.get("errorMessage") or data.get("msg") or status
                self.store.change(cid, state="failed", endedAt=now(),
                                  note=str(reason)[:300], warn="")
                return
            running = bool(data.get("netWssUrl")) or status in ("RUNNING", "PROCESSING")
            self.store.change(
                cid, state="running" if running else "queued",
                note="云端执行中" if running else "云端排队",
                startedAt=(job.get("startedAt") or now()) if running else job.get("startedAt"),
                warn="",
            )
            return
        raise ValueError("RunningHub 返回了无法识别的任务状态")

    async def archive_runninghub(self, job):
        warn = ""
        for item in job["results"]:
            key = output_key(job, item)
            if self.store.media(key):
                continue
            async with self.http.get(item["fileUrl"], allow_redirects=True) as r:
                if r.status != 200:
                    raise ValueError("结果下载失败（HTTP " + str(r.status) + "）")
                mime = r.content_type or mimetypes.guess_type(item["filename"])[0] or "application/octet-stream"
                await self.store.save_stream(r.content, key, item["filename"], mime)
        for item in job["results"]:
            try:
                self.expose(job, item, output_key(job, item))
            except OSError as e:
                warn = "结果已归档，但无法写入输出目录：" + str(e)
        self.store.change(job["client"], archivePending=False, mediaNote="已保存到工作区", warn=warn)

    async def poll(self, job):
        if job_provider(job) == "runninghub":
            return await self.poll_runninghub(job)
        cid, base = job["client"], job["base"]
        queue = await self.json(base, "/queue")
        for group in ("queue_running","queue_pending"):
            for idx,row in enumerate(queue.get(group) or []):
                if not isinstance(row, list) or len(row) < 4:
                    continue
                meta = row[3] if isinstance(row[3], dict) else {}
                if row[1] != (job.get("id") or cid) and meta.get("client_id") != cid:
                    continue
                running = group == "queue_running"
                if job.get("cancel"):
                    if not job.get("cancelAck"):
                        try:
                            await self.json(base, "/api/jobs/"+quote(row[1],safe="")+"/cancel", "POST", json={})
                        except aiohttp.ClientResponseError as e:
                            if e.status not in (404,405):
                                raise
                            await self.json(base, "/interrupt" if running else "/queue", "POST",
                                            json={"prompt_id":row[1]} if running else {"delete":[row[1]]})
                        self.store.change(cid,cancelAck=True)
                else:
                    self.store.change(cid, id=row[1], state="running" if running else "queued",
                                      note="正在执行工作流" if running else f"排队位置 {idx+1}", warn="",
                                      startedAt=(job.get("startedAt") or now()) if running else job.get("startedAt"))
                return
        jid = job.get("id")
        history = await self.json(base, "/history/"+quote(jid,safe="") if jid else "/history?max_items=100")
        if not jid:
            jid = next((k for k,v in history.items() if k==cid or (isinstance(v.get("prompt"),list) and len(v["prompt"])>3 and (v["prompt"][3] or {}).get("client_id")==cid)),None)
        entry = history.get(jid)
        if not entry:
            if job.get("cancelAck"):
                self.store.change(cid, state="cancelled", note="已取消", endedAt=now())
            elif not job.get("id") and now() - int(job.get("submittedAt") or 0) < 180000:
                # Cloud backends can take minutes to start; do not call it lost yet.
                self.store.change(cid, note="已提交，等待服务器排队或启动", warn="", absent=0)
            else:
                # A restarted ComfyUI loses its in-memory queue. After a short
                # grace period the job can no longer be tracked.
                absent = int(job.get("absent") or 0) + 1
                if absent >= 3:
                    self.store.change(
                        cid, state="lost", absent=0, endedAt=now(), warn="",
                        note="ComfyUI 已重启或队列已清空，无法确认任务最终状态",
                    )
                else:
                    self.store.change(cid, absent=absent, warn="")
            return
        status = entry.get("status",{})
        for event, data in status.get("messages",[]):
            if event in ("execution_interrupted","execution_error"):
                self.store.change(cid,state="cancelled" if event=="execution_interrupted" else "failed",
                                  note=data.get("exception_message") or event, endedAt=now(), warn="")
                return
        if status.get("status_str")=="error":
            self.store.change(cid,state="failed",note="ComfyUI 执行失败",endedAt=now())
        elif status.get("completed") or status.get("status_str")=="success" or (not status and "outputs" in entry):
            items = results(entry.get("outputs",{}),job.get("outputNodes"))
            self.store.change(cid, id=jid, state="done" if items else "failed", endedAt=now(), results=items,
                              archivePending=bool(items), note="已生成" if items else "未返回媒体结果",
                              mediaNote="正在保存到工作区" if items else "", warn="")

    def expose(self, job, item, key):
        # Keep a readable copy outside the content-addressed store.
        row = self.store.media(key)
        if not row:
            return
        workflow = self.store.db.execute("SELECT workflow FROM jobs WHERE client=?", (job["client"],)).fetchone()[0]
        target = Path(self.outputs(workflow)).expanduser()
        base = file_base(job.get("title"))
        suffix = Path(item["filename"]).suffix
        source = self.store.root / row["path"]
        self.store.export_output(job["client"], key, source, target / (base + suffix))

    async def archive(self, job):
        warn = ""
        for item in job["results"]:
            key = output_key(job,item)
            if self.store.media(key):
                continue
            params = {k:item[k] for k in ("filename","subfolder","type")}
            async with self.http.get(job["base"]+"/view", params=params, allow_redirects=False) as r:
                if r.status != 200:
                    raise ValueError("结果下载失败（HTTP "+str(r.status)+"）")
                await self.store.save_stream(r.content,key,item["filename"],r.content_type)
        for item in job["results"]:
            try:
                self.expose(job, item, output_key(job,item))
            except OSError as e:
                warn = "结果已归档，但无法写入输出目录：" + str(e)
        self.store.change(job["client"], archivePending=False, mediaNote="已保存到工作区", warn=warn)
