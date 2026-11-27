#!/usr/bin/env python3
"""Local static server for CTViewer development.

`python -m http.server` sends no Cache-Control, so Chrome applies a heuristic
freshness window to every module. Editing js/*.js and reloading within that
window keeps running the old module - which looks exactly like a broken edit.
This server sends no-store, so every reload really is the file on disk.

    python tools/devserver.py 8030
"""
from __future__ import annotations

import functools
import http.server
import socketserver
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:   # quieter than the stdlib
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8030
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=".")
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"CTViewer dev server: http://127.0.0.1:{port}  (Cache-Control: no-store)")
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
