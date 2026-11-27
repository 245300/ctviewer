#!/usr/bin/env bash
# 启动 CTViewer 本地静态服务器
cd "$(dirname "$0")"
PORT="${1:-8030}"
echo "CTViewer: http://127.0.0.1:${PORT}"
python3 -m http.server "$PORT" --bind 0.0.0.0
