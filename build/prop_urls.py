"""Print the Poly Haven 1k glTF file list for the named assets.

Usage:
    python -I build/prop_urls.py <asset> [<asset> ...]

Output: one line per file, tab separated: <url>\t<asset>/<relative path>.
This script never writes files and never runs a subprocess; the caller owns
the download folder. Hosts are pinned to Poly Haven, redirects are refused and
resolved addresses must be public. Asset names are restricted to a slug
alphabet; include names are restricted to plain relative path characters.
"""
import ipaddress
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

ALLOW_HOSTS = {'api.polyhaven.com', 'dl.polyhaven.org'}
ASSET_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_]{0,63}')
INCLUDE_RE = re.compile(r'[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)*')
# This machine resolves through a local proxy that hands out fake-IP addresses
# from the benchmarking range. It is allowed only for the two pinned hosts,
# over https with certificate checks; real internal ranges stay refused.
PROXY_RANGES = (ipaddress.ip_network('198.18.0.0/15'),)


def refuse_address(addr):
    if addr.is_loopback or addr.is_link_local or addr.is_multicast:
        return True
    if addr.is_unspecified or addr.is_reserved:
        return True
    if addr.is_private and not any(addr in net for net in PROXY_RANGES):
        return True
    return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect refused', headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)
HEADERS = {'User-Agent': 'ctviewer-prop-fetch/1.0 (+local build script)'}


def open_url(url, timeout):
    request = urllib.request.Request(url, headers=HEADERS)
    return OPENER.open(request, timeout=timeout)


def check_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https':
        raise SystemExit(f'refusing non-https url: {url}')
    host = (parts.hostname or '').lower()
    if host not in ALLOW_HOSTS:
        raise SystemExit(f'refusing host: {host}')
    for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP):
        addr = ipaddress.ip_address(info[4][0])
        if refuse_address(addr):
            raise SystemExit(f'refusing private address for {host}: {addr}')


def main(names):
    for asset in names:
        if not ASSET_RE.fullmatch(asset):
            raise SystemExit(f'refusing asset name: {asset!r}')
        api = 'https://api.polyhaven.com/files/' + urllib.parse.quote(asset)
        check_url(api)
        with open_url(api, 60) as res:
            files = json.load(res)
        entry = files.get('gltf', {}).get('1k', {}).get('gltf')
        if not entry:
            raise SystemExit(f'{asset}: no 1k glTF entry')
        check_url(entry['url'])
        print(f"{entry['url']}\t{asset}/{asset}.gltf")
        for rel, meta in entry.get('include', {}).items():
            if not INCLUDE_RE.fullmatch(rel) or '..' in rel.split('/'):
                raise SystemExit(f'{asset}: refusing include name: {rel!r}')
            check_url(meta['url'])
            print(f"{meta['url']}\t{asset}/{rel}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
