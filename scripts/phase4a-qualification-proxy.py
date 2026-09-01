#!/usr/bin/env python3
"""Closed deterministic HTTP fixture for installed Phase 4A qualification."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 18877
HEADER_LIMIT = 64 * 1024
FIXTURE_HOST = "93.184.216.34"
HEALTH_TARGET = "http://webx-egress.invalid/.well-known/webx-egress-health"
FIXTURE_PATH = re.compile(r"^/\.well-known/pi-web-qualification/(alpha|beta)$")


class Denied(Exception):
    pass


def regular_private_file(path: Path, maximum: int) -> bytes:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.getuid() or metadata.st_gid != os.getgid() or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > maximum:
        raise RuntimeError("qualification lease is unsafe")
    return path.read_bytes()


def verify_lease() -> None:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime is None or not Path(runtime).is_absolute():
        raise RuntimeError("XDG_RUNTIME_DIR is required")
    runtime_root = Path(runtime).resolve(strict=True)
    lease_path = runtime_root / "pi-web" / "qualification" / "lease.json"
    try:
        lease = json.loads(regular_private_file(lease_path, 4096))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("qualification lease is invalid") from error
    if not isinstance(lease, dict) or set(lease) != {"schemaVersion", "releaseId", "gitSha", "manifestSha256"} or lease.get("schemaVersion") != 1:
        raise RuntimeError("qualification lease is invalid")
    release_id = lease.get("releaseId")
    git_sha = lease.get("gitSha")
    manifest_sha256 = lease.get("manifestSha256")
    if not isinstance(release_id, str) or not re.fullmatch(r"phase4a-[0-9a-f]{40}", release_id) or not isinstance(git_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", git_sha) or release_id != f"phase4a-{git_sha}" or not isinstance(manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
        raise RuntimeError("qualification lease identity is invalid")
    executable = Path(__file__).resolve(strict=True)
    release_root = executable.parent.parent
    if release_root.name != release_id:
        raise RuntimeError("qualification executable release is invalid")
    manifest_path = release_root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha256:
        raise RuntimeError("qualification manifest digest is invalid")
    try:
        manifest = json.loads(manifest_bytes)
    except json.JSONDecodeError as error:
        raise RuntimeError("qualification manifest is invalid") from error
    if not isinstance(manifest, dict) or manifest.get("releaseId") != release_id or manifest.get("gitSha") != git_sha:
        raise RuntimeError("qualification manifest identity is invalid")


def response(status: str, body: bytes = b"", headers: tuple[tuple[bytes, bytes], ...] = ()) -> bytes:
    lines = [f"HTTP/1.1 {status}\r\n".encode("ascii")]
    lines.extend(name + b": " + value + b"\r\n" for name, value in headers)
    lines.extend([f"Content-Length: {len(body)}\r\n".encode("ascii"), b"Connection: close\r\n\r\n", body])
    return b"".join(lines)


def fixture_page(actor: str) -> bytes:
    title = "Actor Alpha" if actor == "alpha" else "Actor Beta"
    color = "#164e63" if actor == "alpha" else "#713f12"
    return f"""<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>body{{font-family:sans-serif;background:{color};color:white}}button{{font-size:24px;margin:30px;padding:20px}}</style></head><body><h1 id=\"actor\">{title}</h1><button id=\"counter\" aria-label=\"increment counter\">0</button><input id=\"human-input\" aria-label=\"qualification input\" autocomplete=\"off\"><script>const b=document.querySelector('#counter');b.addEventListener('click',()=>{{b.textContent=String(Number(b.textContent)+1)}});</script></body></html>""".encode("utf-8")


def route(method: str, target: str, version: str) -> bytes:
    if version not in {"HTTP/1.0", "HTTP/1.1"}:
        raise Denied("HTTP version denied")
    if method == "GET" and target == HEALTH_TARGET:
        return response("204 No Content", headers=((b"WebX-Egress-Proxy", b"secure-egress/1"),))
    if method != "GET":
        raise Denied("method denied")
    parsed = urlsplit(target)
    if parsed.scheme != "http" or parsed.hostname != FIXTURE_HOST or parsed.port not in {None, 80} or parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise Denied("destination denied")
    if parsed.query:
        raise Denied("fixture query denied")
    match = FIXTURE_PATH.fullmatch(parsed.path)
    if match is None:
        raise Denied("fixture path denied")
    return response("200 OK", fixture_page(match.group(1)), ((b"Content-Type", b"text/html; charset=utf-8"), (b"Cache-Control", b"no-store"), (b"X-Pi-Web-Qualification", b"fixture/1")))


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        block = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10.0)
        if len(block) > HEADER_LIMIT:
            raise Denied("headers too large")
        lines = block[:-4].split(b"\r\n")
        parts = lines[0].decode("ascii", "strict").split(" ")
        if len(parts) != 3:
            raise Denied("malformed request")
        writer.write(route(parts[0], parts[1], parts[2]))
    except (Denied, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        writer.write(response("403 Forbidden"))
    except Exception:
        writer.write(response("502 Bad Gateway"))
    try:
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    verify_lease()
    server = await asyncio.start_server(handle, HOST, PORT, limit=HEADER_LIMIT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
