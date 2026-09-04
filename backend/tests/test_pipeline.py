from __future__ import annotations

import shutil
import subprocess
import time
import wave
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg and FFprobe are required for the integration test",
)


def test_complete_mp4_pipeline(tmp_path: Path) -> None:
    silent = tmp_path / "silent.mp4"
    writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*"mp4v"), 12, (320, 180))
    assert writer.isOpened()
    for index in range(15):
        frame = np.zeros((180, 320, 3), dtype=np.uint8)
        frame[:, :, 0] = np.linspace(10, 220, 320, dtype=np.uint8)
        cv2.circle(frame, (35 + index * 17, 90), 28, (245, 225, 80), -1)
        cv2.putText(frame, "ASCII", (100, 104), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (245, 245, 245), 2)
        writer.write(frame)
    writer.release()

    audio = tmp_path / "tone.wav"
    sample_rate = 44_100
    timeline = np.arange(round(1.25 * sample_rate), dtype=np.float64) / sample_rate
    samples = (np.sin(2 * np.pi * 660 * timeline) * 10_000).astype(np.int16)
    with wave.open(str(audio), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(samples.tobytes())

    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(silent),
            "-i",
            str(audio),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-shortest",
            str(source),
        ],
        check=True,
    )

    with TestClient(app) as client:
        with source.open("rb") as video:
            created = client.post("/api/jobs", files={"file": ("source.mp4", video, "video/mp4")})
        assert created.status_code == 201, created.text
        job = created.json()
        assert job["video"]["has_audio"] is True

        preview = client.post(
            f"/api/jobs/{job['id']}/preview",
            json={"grid_width": 48, "character_size": 8, "timestamp": 0.4},
        )
        assert preview.status_code == 200, preview.text
        image = client.get(preview.json()["preview_url"])
        assert image.status_code == 200
        assert image.headers["content-type"].startswith("image/png")

        braille_preview = client.post(
            f"/api/jobs/{job['id']}/preview",
            json={
                "grid_width": 48,
                "character_size": 8,
                "timestamp": 0.4,
                "character_set": "braille",
                "mode": "original_colors",
            },
        )
        assert braille_preview.status_code == 200, braille_preview.text
        assert client.get(braille_preview.json()["preview_url"]).status_code == 200

        started = client.post(
            f"/api/jobs/{job['id']}/process",
            json={
                "grid_width": 48,
                "character_size": 8,
                "fps": 12,
                "quality": "draft",
                "keep_audio": True,
                "character_set": "braille",
                "mode": "original_colors",
                "output_width": 640,
                "output_height": 360,
            },
        )
        assert started.status_code == 202, started.text
        deadline = time.time() + 45
        while time.time() < deadline:
            status = client.get(f"/api/jobs/{job['id']}").json()
            if status["status"] in {"completed", "error", "cancelled"}:
                break
            time.sleep(0.2)
        assert status["status"] == "completed", status
        assert status["result_width"] == 640
        assert status["result_height"] == 360
        assert status["result_size_bytes"] > 0

        result = client.get(status["result_url"])
        assert result.status_code == 200
        output = tmp_path / "result.mp4"
        output.write_bytes(result.content)
        capture = cv2.VideoCapture(str(output))
        try:
            assert capture.isOpened()
            ok, frame = capture.read()
            assert ok and frame is not None
            assert frame.shape[1] == 640
            assert frame.shape[0] == 360
            assert frame.shape[0] % 2 == 0 and frame.shape[1] % 2 == 0
        finally:
            capture.release()

        details = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", str(output)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert '"codec_name": "h264"' in details
        assert '"codec_type": "audio"' in details

        deleted = client.delete(f"/api/jobs/{job['id']}")
        assert deleted.status_code == 204


def test_complete_animated_gif_pipeline(tmp_path: Path) -> None:
    source = tmp_path / "source.gif"
    frames: list[Image.Image] = []
    for index in range(8):
        frame = np.zeros((96, 160, 3), dtype=np.uint8)
        frame[:, :, 1] = np.linspace(25, 200, 160, dtype=np.uint8)
        cv2.rectangle(frame, (8 + index * 17, 28), (40 + index * 17, 67), (245, 110, 230), -1)
        cv2.putText(frame, "GIF", (57, 61), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (250, 250, 250), 2)
        frames.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
    frames[0].save(
        source,
        save_all=True,
        append_images=frames[1:],
        duration=[80, 120, 70, 160, 90, 130, 100, 150],
        loop=0,
        disposal=2,
    )

    with TestClient(app) as client:
        with source.open("rb") as animation:
            created = client.post("/api/jobs", files={"file": ("source.gif", animation, "image/gif")})
        assert created.status_code == 201, created.text
        job = created.json()
        assert job["video"]["has_audio"] is False
        assert job["video"]["duration"] >= 0.8

        preview = client.post(
            f"/api/jobs/{job['id']}/preview",
            json={"grid_width": 48, "character_size": 8, "timestamp": 0.35, "mode": "original_colors"},
        )
        assert preview.status_code == 200, preview.text
        assert client.get(preview.json()["preview_url"]).status_code == 200

        started = client.post(
            f"/api/jobs/{job['id']}/process",
            json={
                "grid_width": 48,
                "character_size": 8,
                "fps": 10,
                "quality": "draft",
                "mode": "original_colors",
                "output_format": "gif",
                "output_width": 320,
                "output_height": 180,
            },
        )
        assert started.status_code == 202, started.text
        deadline = time.time() + 45
        while time.time() < deadline:
            status = client.get(f"/api/jobs/{job['id']}").json()
            if status["status"] in {"completed", "error", "cancelled"}:
                break
            time.sleep(0.2)
        assert status["status"] == "completed", status
        assert status["result_width"] == 320
        assert status["result_height"] == 180

        result = client.get(status["result_url"])
        assert result.status_code == 200
        assert result.headers["content-type"].startswith("image/gif")
        output = tmp_path / "gif-result.gif"
        output.write_bytes(result.content)
        with Image.open(output) as animation:
            assert animation.format == "GIF"
            assert animation.is_animated
            assert animation.n_frames >= 8
            assert animation.info.get("loop") == 0
            assert animation.size == (320, 180)

        assert client.delete(f"/api/jobs/{job['id']}").status_code == 204
