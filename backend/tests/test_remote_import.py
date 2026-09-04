from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import app.main as main_module
from app.main import app
from app.remote import RemoteDownload, RemoteDownloadError, _validate_public_url


def fake_downloader(source: Path, content_type: str):
    async def download(url: str, destination: Path, max_bytes: int) -> RemoteDownload:
        data = source.read_bytes()
        assert len(data) <= max_bytes
        destination.write_bytes(data)
        return RemoteDownload(final_url=url, content_type=content_type, size=len(data), header=data[:64])

    return download


def test_private_url_is_blocked() -> None:
    with pytest.raises(RemoteDownloadError, match="приватные"):
        asyncio.run(_validate_public_url("http://127.0.0.1/private.mp4"))


def test_image_can_be_imported_from_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "remote.png"
    image = Image.new("RGB", (180, 110), "#17202a")
    draw = ImageDraw.Draw(image)
    draw.ellipse((35, 15, 145, 105), fill="#e9f5ff")
    draw.text((70, 49), "URL", fill="#101315")
    image.save(source)
    monkeypatch.setattr(main_module, "download_remote", fake_downloader(source, "image/png"))

    with TestClient(app) as client:
        created = client.post("/api/images/url", json={"url": "https://example.com/photo.png"})
        assert created.status_code == 201, created.text
        job = created.json()
        assert job["image"]["format"] == "png"
        assert client.get(job["source_url"]).status_code == 200

        processed = client.post(f"/api/images/{job['id']}/process", json={"grid_width": 40})
        assert processed.status_code == 200, processed.text
        result = processed.json()
        assert client.get(result["result_image_url"]).status_code == 200
        assert len(client.get(result["result_text_url"]).text.splitlines()) > 5
        assert client.delete(f"/api/images/{job['id']}").status_code == 204


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg and FFprobe are required for remote GIF conversion",
)
def test_gif_can_be_imported_from_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "remote.gif"
    frames = []
    for index in range(6):
        frame = Image.new("RGB", (120, 80), "#050607")
        draw = ImageDraw.Draw(frame)
        draw.rectangle((8 + index * 14, 22, 34 + index * 14, 58), fill="#c8ff3d")
        frames.append(frame)
    frames[0].save(source, save_all=True, append_images=frames[1:], duration=100, loop=0)
    monkeypatch.setattr(main_module, "download_remote", fake_downloader(source, "image/gif"))

    with TestClient(app) as client:
        created = client.post("/api/jobs/url", json={"url": "https://example.com/animation.gif"})
        assert created.status_code == 201, created.text
        job = created.json()
        assert job["source_format"] == "gif"
        assert client.get(job["source_url"]).headers["content-type"].startswith("image/gif")

        started = client.post(
            f"/api/jobs/{job['id']}/process",
            json={"grid_width": 36, "character_size": 8, "fps": 10, "quality": "draft", "output_format": "gif"},
        )
        assert started.status_code == 202, started.text
        deadline = time.time() + 30
        while time.time() < deadline:
            status = client.get(f"/api/jobs/{job['id']}").json()
            if status["status"] in {"completed", "error", "cancelled"}:
                break
            time.sleep(0.1)
        assert status["status"] == "completed", status
        result = client.get(status["result_url"])
        assert result.status_code == 200
        assert result.content.startswith((b"GIF87a", b"GIF89a"))
        assert client.delete(f"/api/jobs/{job['id']}").status_code == 204
