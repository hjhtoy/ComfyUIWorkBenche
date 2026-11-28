"""Disk workspace. Media are immutable, content-addressed files."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import uuid
import zipfile


class Conflict(ValueError):
    pass


def ensure_dir(path):
    # An explicit check also works behind file-operation proxies that raise
    # EEXIST even when exist_ok=True was requested.
    if not path.is_dir():
        path.mkdir(parents=True, exist_ok=True)


def downloads_directory():
    if os.name == "nt":
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                value, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
                return Path(os.path.expandvars(value))
        except OSError:
            pass
    elif os.name == "posix":
        config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        try:
            entry = re.search(r'^XDG_DOWNLOAD_DIR="([^"\r\n]+)"\s*$', (config / "user-dirs.dirs").read_text(),
                              re.MULTILINE)
            if entry:
                path = Path(entry[1].replace("$HOME", str(Path.home())))
                if path.is_absolute():
                    return path
        except OSError:
            pass
    return Path.home() / "Downloads"


def output_key(job, item):
    return "output:" + ":".join([job["base"], job["id"], item["filename"], item["subfolder"]])


def unlink_matching_output(path, digest, legacy_source=None):
    if path.is_symlink() or not path.is_file():
        return
    try:
        if legacy_source and path.stat().st_mtime_ns != legacy_source.stat().st_mtime_ns:
            return
        with path.open("rb") as source:
            hashed = hashlib.sha256()
            while block := source.read(1024**2):
                hashed.update(block)
        if hashed.hexdigest() == digest:
            path.unlink(missing_ok=True)
    except (FileNotFoundError, IsADirectoryError):
        pass


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "workspace.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY, rev INTEGER NOT NULL, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS media(key TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs(n INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT UNIQUE NOT NULL, workflow TEXT NOT NULL, data TEXT NOT NULL, plan TEXT);
          CREATE TABLE IF NOT EXISTS job_exports(client TEXT NOT NULL, media_key TEXT NOT NULL, path TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, PRIMARY KEY(client,media_key));
          CREATE INDEX IF NOT EXISTS workflow_jobs ON jobs(workflow,n);
          CREATE TABLE IF NOT EXISTS identity(id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS queue_versions(workflow TEXT PRIMARY KEY, rev INTEGER NOT NULL);
          CREATE TRIGGER IF NOT EXISTS queue_added AFTER INSERT ON jobs BEGIN
            INSERT INTO queue_versions VALUES(NEW.workflow,1) ON CONFLICT(workflow) DO UPDATE SET rev=rev+1;
          END;
          CREATE TRIGGER IF NOT EXISTS queue_changed AFTER UPDATE ON jobs BEGIN
            UPDATE queue_versions SET rev=rev+1 WHERE workflow=NEW.workflow;
          END;
          CREATE TRIGGER IF NOT EXISTS queue_removed AFTER DELETE ON jobs BEGIN
            UPDATE queue_versions SET rev=rev+1 WHERE workflow=OLD.workflow;
          END;
        """)
        with self.db:
            if not self.db.execute("SELECT 1 FROM identity").fetchone():
                self.db.execute("INSERT INTO identity VALUES(?)", (str(uuid.uuid4()),))
        for name in ("assets", "outputs", "staging"):
            ensure_dir(self.root / name)

    def record(self, key):
        row = self.db.execute("SELECT rev,value FROM records WHERE key=?", (key,)).fetchone()
        return dict(rev=row[0], value=json.loads(row[1])) if row else dict(rev=0, value=None)

    def records(self):
        return {k: dict(rev=r, value=json.loads(v)) for k,r,v in self.db.execute("SELECT * FROM records")}

    def put_record(self, key, rev, value):
        with self.db:
            current = self.record(key)
            if current["rev"] != rev:
                raise Conflict("其他窗口已更新这项数据。请保留当前编辑内容，刷新后再合并。")
            self.db.execute("INSERT OR REPLACE INTO records VALUES(?,?,?)", (key, rev+1, json.dumps(value)))
        return dict(rev=rev+1, value=value)

    def media(self, key):
        return self.db.execute("SELECT * FROM media WHERE key=?", (key,)).fetchone()

    def finish_file(self, temp, digest, key, name, mime):
        bucket = "outputs" if key.startswith("output:") else "assets"
        rel = f"{bucket}/{digest[:2]}/{digest}"
        dest = self.root / rel
        ensure_dir(dest.parent)
        if not dest.exists():
            os.replace(temp, dest)
        with self.db:
            old = self.media(key)
            if old and old["path"] != rel:
                raise Conflict("相同素材编号对应不同内容。")
            self.db.execute("INSERT OR IGNORE INTO media VALUES(?,?,?,?)", (key, rel, name, mime))

    async def save_stream(self, stream, key, name, mime):
        digest = hashlib.sha256()
        with tempfile.NamedTemporaryFile(dir=self.root/"staging", delete=False) as out:
            temp = Path(out.name)
        try:
            with temp.open("wb") as out:
                async for block in stream.iter_chunked(1024*1024):
                    digest.update(block)
                    out.write(block)
                out.flush()
                os.fsync(out.fileno())
            self.finish_file(temp, digest.hexdigest(), key, name, mime)
        finally:
            temp.unlink(missing_ok=True)

    def jobs(self, workflow=None):
        rows = self.db.execute("SELECT n,data FROM jobs WHERE workflow=? ORDER BY n", (workflow,)) if workflow else self.db.execute("SELECT n,data FROM jobs ORDER BY n")
        return [dict(json.loads(data), n=n) for n,data in rows]

    def job(self, client):
        row = self.db.execute("SELECT * FROM jobs WHERE client=?", (client,)).fetchone()
        if not row:
            raise KeyError("任务不存在")
        return dict(json.loads(row["data"]), n=row["n"])

    def change(self, client, **changes):
        data = self.job(client)
        if all(data.get(k) == v for k,v in changes.items()):
            return data
        data.update(changes)
        with self.db:
            self.db.execute("UPDATE jobs SET data=? WHERE client=?", (json.dumps(data), client))
        return data

    def insert_job(self, workflow, data, plan=None):
        self.db.execute("INSERT OR IGNORE INTO jobs(client,workflow,data,plan) VALUES(?,?,?,?)",
                        (data["client"], workflow, json.dumps(data), json.dumps(plan) if plan else None))

    def export_output(self, client, key, source, destination):
        saved = self.db.execute("SELECT path FROM job_exports WHERE client=? AND media_key=?",
                                (client, key)).fetchone()
        if saved and Path(saved["path"]).is_file():
            return
        with self.db:
            self.db.execute("DELETE FROM job_exports WHERE client=? AND media_key=?", (client, key))
        destination = destination.parent.resolve() / destination.name
        ensure_dir(destination.parent)
        index = 0
        while True:
            suffix = "" if index == 0 else "-" + client[:8] + (f"-{index}" if index > 1 else "")
            name = re.sub(r'[^a-zA-Z0-9_-]', "_", suffix)
            path = destination.with_stem(destination.stem + name)
            index += 1
            if self.db.execute("SELECT 1 FROM job_exports WHERE path=?", (str(path),)).fetchone():
                continue
            try:
                out = path.open("xb")
            except FileExistsError:
                continue
            try:
                with out, source.open("rb") as inp:
                    shutil.copyfileobj(inp, out)
                with self.db:
                    self.db.execute("INSERT INTO job_exports VALUES(?,?,?,?)",
                                    (client, key, str(path), source.name))
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return

    def delete_jobs(self, selected, legacy_paths, *, delete_files=False):
        with self.db:
            for job, _ in selected:
                self.db.execute("DELETE FROM jobs WHERE client=?", (job["client"],))
            if not delete_files:
                return
            for job, workflow in selected:
                cid = job["client"]
                exports = self.db.execute("SELECT * FROM job_exports WHERE client=?", (cid,)).fetchall()
                for exported in exports:
                    path = Path(exported["path"])
                    if path.is_absolute() and path.resolve() == path:
                        unlink_matching_output(path, exported["digest"])
                if job.get("id"):
                    shared = self.db.execute("""
                        SELECT 1 FROM jobs WHERE json_extract(data,'$.base')=?
                        AND json_extract(data,'$.id')=? LIMIT 1
                    """, (job["base"], job["id"])).fetchone()
                    tracked = {row["media_key"] for row in exports}
                    for item in job.get("results") or ():
                        key = output_key(job, item)
                        row = self.media(key)
                        if not row or shared:
                            continue
                        source = self.root / row["path"]
                        if key not in tracked:
                            for path in legacy_paths(job, workflow, item):
                                if not self.db.execute("SELECT 1 FROM job_exports WHERE path=?",
                                                       (str(path.resolve()),)).fetchone():
                                    unlink_matching_output(path, source.name, legacy_source=source)
                        self.db.execute("DELETE FROM media WHERE key=?", (key,))
                        if not self.db.execute("SELECT 1 FROM media WHERE path=?", (row["path"],)).fetchone():
                            source.unlink(missing_ok=True)
                self.db.execute("DELETE FROM job_exports WHERE client=?", (cid,))

    def secret(self, name):
        row = self.db.execute("SELECT value FROM secrets WHERE name=?", (name,)).fetchone()
        return row[0] if row else None

    def set_secret(self, name, value):
        with self.db:
            self.db.execute(
                "INSERT INTO secrets(name,value) VALUES(?,?) "
                "ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                (name, value),
            )

    def clear_secret(self, name):
        with self.db:
            self.db.execute("DELETE FROM secrets WHERE name=?", (name,))


def backup(root, target):
    root, target = Path(root).resolve(), Path(target).resolve()
    if target.exists():
        raise ValueError("备份文件已存在")
    if not (root/"workspace.sqlite").is_file():
        raise ValueError("找不到工作区数据库")
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        snapshot = Path(tmp)/"workspace.sqlite"
        with contextlib.closing(sqlite3.connect(root/"workspace.sqlite")) as source, contextlib.closing(sqlite3.connect(snapshot)) as dest:
            source.backup(dest)
            paths = [row[0] for row in dest.execute("SELECT DISTINCT path FROM media")]
        archive = Path(tmp)/"backup.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.write(snapshot, "workspace.sqlite")
            for path in paths:
                z.write(root/path, path)
        os.link(archive, target)


def restore(archive, target):
    target = Path(target).expanduser().resolve()
    if target.exists():
        raise ValueError("请选择尚不存在的新工作区目录")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp, zipfile.ZipFile(archive) as z:
        stage = Path(tmp)/"workspace"
        stage.mkdir()
        snapshot = stage/"workspace.sqlite"
        with z.open("workspace.sqlite") as src, snapshot.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        with contextlib.closing(sqlite3.connect(snapshot)) as db, db:
            db.execute("PRAGMA trusted_schema=OFF")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("数据库校验失败")
            db.execute("SELECT id FROM identity").fetchone()
            paths = db.execute("SELECT DISTINCT path FROM media").fetchall()
            # Absolute export paths belong to the installation that created them.
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_exports'").fetchone():
                db.execute("DELETE FROM job_exports")
        for (path,) in paths:
            if not re.fullmatch(r"(assets|outputs)/[a-f0-9]{2}/[a-f0-9]{64}", path):
                raise ValueError("媒体路径无效")
            dst = stage/path
            dst.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with z.open(path) as src, dst.open("wb") as out:
                while block := src.read(1024*1024):
                    digest.update(block)
                    out.write(block)
            if digest.hexdigest() != dst.name:
                raise ValueError("媒体校验失败")
        stage.rename(target)
