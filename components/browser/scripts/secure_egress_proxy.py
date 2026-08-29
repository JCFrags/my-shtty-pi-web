#!/usr/bin/env python3
"""A small forward proxy that pins each public destination connection.

The proxy rejects credentials, local names, non-public addresses, and mixed DNS
answers. HTTPS uses CONNECT. Each new host or redirect must pass through a new
validated proxy connection.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from urllib.parse import urlsplit

HOST = os.getenv("PI_WEB_EGRESS_HOST", "127.0.0.1")
PORT = int(os.getenv("PI_WEB_EGRESS_PORT", "8877"))
HEADER_LIMIT = 64 * 1024
CONNECT_TIMEOUT = 15.0
IDLE_TIMEOUT = 120.0


class ProxyDenied(Exception):
    pass


def validate_listener(host: str, port: int) -> tuple[str, int]:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise RuntimeError("proxy listener must use a loopback IP literal") from error
    if not address.is_loopback:
        raise RuntimeError("proxy listener must use a loopback IP literal")
    if port < 1 or port > 65535:
        raise RuntimeError("proxy listener port is invalid")
    return str(address), port


def validate_host(host: str) -> str:
    normalized = host.rstrip(".").lower()
    if not normalized or normalized == "localhost" or normalized.endswith(".localhost"):
        raise ProxyDenied("local destination denied")
    return normalized


async def resolve_public(host: str, port: int) -> list[tuple[int, str]]:
    host = validate_host(host)
    try:
        direct = ipaddress.ip_address(host)
        answers = [(socket.AF_INET6 if direct.version == 6 else socket.AF_INET, str(direct))]
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            records = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as error:
            raise ProxyDenied("destination resolution failed") from error
        answers = []
        for family, _kind, _proto, _canon, sockaddr in records:
            address = sockaddr[0]
            pair = (family, address)
            if pair not in answers:
                answers.append(pair)
    if not answers:
        raise ProxyDenied("destination has no addresses")
    if any(not ipaddress.ip_address(address).is_global for _family, address in answers):
        raise ProxyDenied("destination resolved to a non-public address")
    return answers


async def open_pinned(host: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    answers = await resolve_public(host, port)
    last_error: Exception | None = None
    for family, address in answers:
        try:
            return await asyncio.wait_for(
                asyncio.open_connection(address, port, family=family), CONNECT_TIMEOUT
            )
        except (TimeoutError, OSError) as error:
            last_error = error
    raise ProxyDenied("public destination connection failed") from last_error


def parse_authority(authority: str, default_port: int) -> tuple[str, int]:
    parsed = urlsplit(f"//{authority}")
    if parsed.username is not None or parsed.password is not None:
        raise ProxyDenied("destination credentials denied")
    if parsed.hostname is None:
        raise ProxyDenied("destination host missing")
    try:
        port = parsed.port or default_port
    except ValueError as error:
        raise ProxyDenied("destination port invalid") from error
    if port < 1 or port > 65535:
        raise ProxyDenied("destination port invalid")
    return validate_host(parsed.hostname), port


async def copy_stream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await asyncio.wait_for(reader.read(64 * 1024), IDLE_TIMEOUT):
            writer.write(data)
            await writer.drain()
    except (TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.write_eof()
        except (AttributeError, OSError):
            pass


async def tunnel(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    remote_reader: asyncio.StreamReader,
    remote_writer: asyncio.StreamWriter,
) -> None:
    await asyncio.gather(
        copy_stream(client_reader, remote_writer),
        copy_stream(remote_reader, client_writer),
    )
    remote_writer.close()
    await remote_writer.wait_closed()


async def handle_connect(
    target: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    host, port = parse_authority(target, 443)
    remote_reader, remote_writer = await open_pinned(host, port)
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    await tunnel(reader, writer, remote_reader, remote_writer)


async def handle_http(
    method: str,
    target: str,
    version: str,
    header_lines: list[bytes],
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    parsed = urlsplit(target)
    if parsed.scheme != "http" or parsed.hostname is None or parsed.fragment:
        raise ProxyDenied("proxy requires an absolute public HTTP URL")
    if parsed.username is not None or parsed.password is not None:
        raise ProxyDenied("destination credentials denied")
    try:
        port = parsed.port or 80
    except ValueError as error:
        raise ProxyDenied("destination port invalid") from error
    host = validate_host(parsed.hostname)
    remote_reader, remote_writer = await open_pinned(host, port)
    path = parsed.path or "/"
    if parsed.query:
        path += f"?{parsed.query}"
    retained = []
    for line in header_lines:
        name = line.split(b":", 1)[0].strip().lower()
        if name not in {b"proxy-authorization", b"proxy-connection", b"host", b"connection"}:
            retained.append(line)
    host_header = host if port == 80 else f"{host}:{port}"
    request = [f"{method} {path} {version}\r\n".encode(), f"Host: {host_header}\r\n".encode()]
    request.extend(line + b"\r\n" for line in retained)
    request.append(b"Connection: close\r\n\r\n")
    remote_writer.writelines(request)
    await remote_writer.drain()
    await tunnel(reader, writer, remote_reader, remote_writer)


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        block = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10.0)
        if len(block) > HEADER_LIMIT:
            raise ProxyDenied("request headers too large")
        lines = block[:-4].split(b"\r\n")
        parts = lines[0].decode("ascii", "strict").split(" ")
        if len(parts) != 3:
            raise ProxyDenied("malformed proxy request")
        method, target, version = parts
        if version not in {"HTTP/1.0", "HTTP/1.1"}:
            raise ProxyDenied("HTTP version denied")
        if method.upper() == "CONNECT":
            await handle_connect(target, reader, writer)
        else:
            await handle_http(method, target, version, lines[1:], reader, writer)
    except (
        ProxyDenied,
        UnicodeError,
        asyncio.IncompleteReadError,
        asyncio.LimitOverrunError,
    ) as error:
        message = str(error).encode("ascii", "replace")[:200]
        writer.write(
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: "
            + str(len(message)).encode()
            + b"\r\n\r\n"
            + message
        )
        await writer.drain()
    except Exception:  # noqa: BLE001 - isolate malformed or failed client connections
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    host, port = validate_listener(HOST, PORT)
    server = await asyncio.start_server(handle_client, host, port, limit=HEADER_LIMIT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
