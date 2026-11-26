#!/bin/bash
# Frameform 工作区一键启动（macOS）。双击本文件或在终端执行均可。
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
DATA="${FRAMEFORM_DATA:-$HOME/FrameformData}"

echo "==> 检查运行环境"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "未找到 Node.js。请先安装 Node.js 20+：https://nodejs.org/"
  read -r -p "按回车退出..."
  exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "未找到 Python 3。请先安装 Python 3.10+：https://www.python.org/downloads/"
  read -r -p "按回车退出..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> 首次运行，安装 npm 依赖"
  npm ci
fi

if [ ! -x .venv/bin/python ]; then
  echo "==> 首次运行，创建 Python 虚拟环境"
  python3 -m venv .venv
fi
echo "==> 确认工作区服务依赖"
PIP_USER=0 .venv/bin/python -m pip install -q -r workspace/requirements.txt

if [ ! -f dist/Frameform.html ]; then
  echo "==> 首次运行，构建工作台页面"
  npm run build
fi

echo ""
echo "工作台地址: http://127.0.0.1:$PORT"
echo "数据目录:   $DATA"
echo "按 Ctrl+C 停止服务。修改源码后请先运行 npm run build 再启动。"
( sleep 2; open "http://127.0.0.1:$PORT" ) &
exec .venv/bin/python -m workspace --data "$DATA" serve --port "$PORT"
