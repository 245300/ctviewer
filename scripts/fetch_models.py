#!/usr/bin/env python3
"""Download the CC-licensed source GLBs listed in scripts/models.json.

Two kinds of entries are supported:

* a single file   (``sourcePath``)           -> ``<out>/<sourceFile>``
* pre-split parts (``mergeBase`` + ``parts``) -> ``<out>/_parts/<id>/<part>``
  and ``scripts/merge_parts.mjs`` assembles them into ``<sourceFile>``.

Downloads are restricted to https + the GitHub raw host, and redirects are
validated before they are followed.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://raw.githubusercontent.com/supercar3d/supercar_3D_asssets/main/"
ALLOWED_HOSTS = {"raw.githubusercontent.com"}


def safe_url(url: str) -> str:
    """Only https to the allow-listed asset host, and never a private address."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"refusing non-https url: {url}")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise ValueError(f"refusing host: {host}")
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP):
        ip = sockaddr[0]
        if family == socket.AF_INET:
            parts = [int(p) for p in ip.split(".")]
            private = (parts[0] in (10, 127) or parts[:2] == [169, 254]
                       or parts[:2] == [192, 168] or (parts[0] == 172 and 16 <= parts[1] <= 31))
        else:
            private = ip in ("::1",) or ip.lower().startswith(("fc", "fd", "fe80"))
        if private:
            raise ValueError(f"refusing private address: {ip}")
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


opener = urllib.request.build_opener(SafeRedirect)


def download(url: str, target: Path) -> None:
    safe_url(url)
    target.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "ctviewer-build"})
    tmp = target.with_suffix(target.suffix + ".part")
    with opener.open(req, timeout=300) as r, tmp.open("wb") as f:
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, target)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "models_src"))
    ap.add_argument("--only", default="", help="comma separated model ids")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {s for s in args.only.split(",") if s}

    models = json.loads((ROOT / "scripts" / "models.json").read_text(encoding="utf-8"))
    for model in models:
        if only and model["id"] not in only:
            continue

        if model.get("parts"):
            base = model["mergeBase"].rstrip("/") + "/"
            dest = out / "_parts" / model["id"]
            for rel in model["parts"]:
                target = dest / rel
                if target.exists() and target.stat().st_size > 500:
                    continue
                download(BASE + base + rel, target)
            print(f"✓ {model['id']:22s} {len(model['parts'])} parts")
            continue

        target = out / model["sourceFile"]
        if target.exists() and target.stat().st_size > 10000:
            print(f"✓ {model['id']:22s} cached {target.stat().st_size/1048576:.2f} MB")
            continue
        url = (model.get("remoteBase") or BASE) + model["sourcePath"]
        print(f"↓ {model['id']:22s} {url}")
        download(url, target)
        print(f"  saved {target.stat().st_size/1048576:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
