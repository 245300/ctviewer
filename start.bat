@echo off
cd /d %~dp0
echo CTViewer: http://127.0.0.1:8030
python -m http.server 8030 --bind 0.0.0.0
