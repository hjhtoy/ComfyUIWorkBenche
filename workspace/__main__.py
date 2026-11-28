import argparse
import os
from pathlib import Path
from .store import backup, downloads_directory, restore

parser = argparse.ArgumentParser(description="Frameform 本地工作区")
parser.add_argument("--data", type=Path, default=Path.home()/"FrameformData", help="工作区目录")
parser.add_argument("--outputs", type=Path, help="未设置工作流目录时使用的默认路径（默认系统下载目录）")
sub = parser.add_subparsers(dest="action")
serve = sub.add_parser("serve")
serve.add_argument("--host",default="127.0.0.1")
serve.add_argument("--port",type=int,default=8787)
serve.add_argument("--cert",type=Path,help="HTTPS 证书链")
serve.add_argument("--key",type=Path,help="HTTPS 私钥")
for cmd in ("backup","restore","migrate"):
    sub.add_parser(cmd).add_argument("archive",type=Path)
args = parser.parse_args()
try:
    if args.action == "backup":
        backup(args.data,args.archive)
    elif args.action == "restore":
        restore(args.archive,args.data)
    elif args.action == "migrate":
        from .migration import migrate
        migrate(args.archive,args.data)
    else:
        from aiohttp import web
        from .server import create_app
        html = Path(__file__).resolve().parents[1]/"dist"/"Frameform.html"
        if not html.exists():
            parser.error("请先运行 npm run build")
        host = getattr(args,"host","127.0.0.1")
        port = getattr(args,"port",8787)
        tls = None
        if getattr(args,"cert",None) or getattr(args,"key",None):
            import ssl
            if not args.cert or not args.key:
                parser.error("--cert 和 --key 需同时指定")
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(args.cert,args.key)
        app = create_app(args.data,html,host,os.environ.get("FRAMEFORM_PASSWORD"),getattr(args,"outputs",None))
        print("工作区目录", args.data.expanduser().resolve(),flush=True)
        print("默认输出目录", (args.outputs.expanduser().resolve() if args.outputs else downloads_directory()),flush=True)
        web.run_app(app,host=host,port=port,ssl_context=tls)
except (ValueError,OSError) as e:
    parser.exit(1,str(e)+"\n")
