import hashlib
import json
from pathlib import Path
import tempfile
from .store import Store


def migrate(archive, target):
    target = Path(target).expanduser().resolve()
    if target.exists():
        raise ValueError("迁移目标须为尚不存在的新工作区目录")
    target.parent.mkdir(parents=True,exist_ok=True)
    with open(archive,"rb") as src, tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        if src.readline(32) != b"FRAMEFORM-1\n":
            raise ValueError("文件不是旧版工作台迁移包")
        size = int(src.readline(24))
        if not 0 < size <= 256*1024**2:
            raise ValueError("迁移清单大小无效")
        manifest = json.loads(src.read(size))
        if manifest.get("format") != 1:
            raise ValueError("不支持的迁移版本")
        stage = Path(tmp)/"workspace"
        store = Store(stage)
        try:
            for entry in manifest["media"]:
                digest = hashlib.sha256()
                remaining = entry["size"]
                if not isinstance(remaining,int) or remaining < 0:
                    raise ValueError("媒体文件大小无效")
                temp = stage/"staging"/"import"
                with temp.open("wb") as out:
                    while remaining:
                        block = src.read(min(remaining,1024**2))
                        if not block:
                            raise ValueError("迁移包不完整")
                        out.write(block)
                        digest.update(block)
                        remaining -= len(block)
                store.finish_file(temp,digest.hexdigest(),entry["key"],entry["name"],entry["mime"] or "application/octet-stream")
                temp.unlink(missing_ok=True)
            if src.read(1):
                raise ValueError("迁移包长度不匹配")
            for key,value in manifest["records"].items():
                store.put_record(key,0,value)
            with store.db:
                for entry in manifest["jobs"]:
                    job = entry["job"]
                    if job.get("state") not in ("done","cancelled","failed","lost") and not job.get("sent"):
                        job.update(state="lost", note="旧任务缺少可重放的提交参数")
                    store.insert_job(entry["workflow"],job)
            missing = manifest["missing"]
            store.put_record("workspace.migration-report",0,missing)
        finally:
            store.db.close()
        stage.rename(target)
        print(f"已迁移 {len(manifest['media'])} 个媒体文件、{len(manifest['jobs'])} 条任务。缺少本地副本 {len(missing)} 项。")
        for item in missing:
            print("缺少本地副本", item["name"],item["key"])
