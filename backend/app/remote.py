from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx


class RemoteDownloadError(ValueError):
    pass


@dataclass(frozen=True)
class RemoteDownload:
    final_url: str
    content_type: str
    size: int
    header: bytes


def _assert_public_addresses(hostname: str, port: int) -> None:
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise RemoteDownloadError("Не удалось определить адрес сервера по этой ссылке.") from exc
    if not addresses:
        raise RemoteDownloadError("Ссылка не содержит доступного сетевого адреса.")
    for address in addresses:
        raw = address[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise RemoteDownloadError("Сервер вернул некорректный сетевой адрес.") from exc
        if not ip.is_global or (getattr(ip, "ipv4_mapped", None) and not ip.ipv4_mapped.is_global):
            raise RemoteDownloadError("Локальные, служебные и приватные сетевые адреса запрещены.")


async def _validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise RemoteDownloadError("Ссылка должна начинаться с http:// или https://.")
    if not parsed.hostname or parsed.username or parsed.password:
        raise RemoteDownloadError("Ссылка содержит недопустимый адрес или данные авторизации.")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise RemoteDownloadError("В ссылке указан некорректный порт.") from exc
    await asyncio.to_thread(_assert_public_addresses, parsed.hostname, port)


async def download_remote(url: str, destination: Path, max_bytes: int) -> RemoteDownload:
    current_url = url.strip()
    if len(current_url) > 2048:
        raise RemoteDownloadError("Ссылка слишком длинная.")
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=20.0, pool=10.0)
    headers = {
        "Accept": "video/mp4,image/gif,image/png,image/jpeg,image/webp,application/octet-stream;q=0.8,*/*;q=0.1",
        "User-Agent": "ASCII-Motion/1.0",
    }
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        for _ in range(5):
            await _validate_public_url(current_url)
            try:
                async with client.stream("GET", current_url, headers=headers) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise RemoteDownloadError("Сервер вернул перенаправление без нового адреса.")
                        current_url = urljoin(current_url, location)
                        continue
                    if response.status_code < 200 or response.status_code >= 300:
                        raise RemoteDownloadError(f"Сервер по ссылке вернул ошибку HTTP {response.status_code}.")
                    declared_length = response.headers.get("content-length")
                    if declared_length:
                        try:
                            declared_size = int(declared_length)
                        except ValueError:
                            declared_size = 0
                        if declared_size > max_bytes:
                            raise RemoteDownloadError("Файл по ссылке превышает допустимый размер.")
                    total = 0
                    first_bytes = bytearray()
                    with destination.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            total += len(chunk)
                            if total > max_bytes:
                                raise RemoteDownloadError("Файл по ссылке превышает допустимый размер.")
                            if len(first_bytes) < 64:
                                first_bytes.extend(chunk[: 64 - len(first_bytes)])
                            output.write(chunk)
                    if total == 0:
                        raise RemoteDownloadError("По ссылке получен пустой файл.")
                    return RemoteDownload(
                        final_url=current_url,
                        content_type=response.headers.get("content-type", "").split(";", 1)[0].lower(),
                        size=total,
                        header=bytes(first_bytes),
                    )
            except httpx.TimeoutException as exc:
                raise RemoteDownloadError("Сервер по ссылке не ответил вовремя.") from exc
            except httpx.RequestError as exc:
                raise RemoteDownloadError("Не удалось скачать файл по этой ссылке.") from exc
        raise RemoteDownloadError("Ссылка содержит слишком много перенаправлений.")
