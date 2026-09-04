from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def test_image_to_png_and_text(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    canvas = np.zeros((180, 260, 3), dtype=np.uint8)
    canvas[:, :, 0] = np.linspace(15, 235, 260, dtype=np.uint8)
    canvas[:, :, 1] = np.linspace(220, 25, 260, dtype=np.uint8)
    cv2.circle(canvas, (130, 82), 58, (242, 218, 170), -1)
    cv2.circle(canvas, (109, 70), 7, (20, 25, 30), -1)
    cv2.circle(canvas, (151, 70), 7, (20, 25, 30), -1)
    cv2.ellipse(canvas, (130, 100), (24, 11), 0, 0, 180, (30, 35, 40), 3)
    assert cv2.imwrite(str(source), canvas)

    with TestClient(app) as client:
        with source.open("rb") as image:
            created = client.post("/api/images", files={"file": ("portrait.png", image, "image/png")})
        assert created.status_code == 201, created.text
        job = created.json()
        assert job["image"] == {"width": 260, "height": 180, "format": "png"}

        processed = client.post(
            f"/api/images/{job['id']}/process",
            json={
                "grid_width": 52,
                "character_size": 9,
                "contrast": 1.35,
                "character_set": "console",
                "mode": "original_colors",
            },
        )
        assert processed.status_code == 200, processed.text
        result = processed.json()
        assert result["status"] == "completed"

        png = client.get(result["result_image_url"])
        assert png.status_code == 200
        assert png.headers["content-type"].startswith("image/png")
        output = tmp_path / "ascii.png"
        output.write_bytes(png.content)
        with Image.open(output) as rendered:
            assert rendered.format == "PNG"
            assert rendered.width >= 250

        text = client.get(result["result_text_url"])
        assert text.status_code == 200
        lines = text.text.rstrip("\n").splitlines()
        assert len(lines) > 10
        assert all(len(line) == 52 for line in lines)
        assert set("".join(lines)).issubset(set("@$#S%?*+;:,./\\|_- ."))

        download = client.get(f"/api/images/{job['id']}/result?format=txt&download=true")
        assert "ascii-image.txt" in download.headers["content-disposition"]

        detailed = client.post(
            f"/api/images/{job['id']}/process",
            json={"grid_width": 220, "character_size": 8, "character_set": "detailed", "mode": "original_colors"},
        )
        assert detailed.status_code == 200, detailed.text
        detailed_text = client.get(detailed.json()["result_text_url"])
        assert detailed_text.status_code == 200
        assert all(len(line) == 220 for line in detailed_text.text.rstrip("\n").splitlines())

        exact = client.post(
            f"/api/images/{job['id']}/process",
            json={
                "target_character_count": 1000,
                "character_size": 9,
                "character_set": "braille",
                "mode": "original_colors",
            },
        )
        assert exact.status_code == 200, exact.text
        exact_text = client.get(exact.json()["result_text_url"])
        assert exact_text.status_code == 200
        exact_lines = exact_text.text.rstrip("\n").splitlines()
        assert sum(len(line) for line in exact_lines) == 1000
        assert max(map(len, exact_lines)) - min(map(len, exact_lines)) <= 1
        exact_characters = "".join(exact_lines)
        assert all(0x2800 <= ord(character) <= 0x28FF for character in exact_characters)
        assert any(character != "\u2800" for character in exact_characters)

        compressed = client.post(
            f"/api/images/{job['id']}/process",
            json={
                "grid_width": 52,
                "character_size": 9,
                "output_width": 320,
                "output_height": 240,
                "output_format": "jpeg",
                "quality": "draft",
            },
        )
        assert compressed.status_code == 200, compressed.text
        compressed_job = compressed.json()
        assert compressed_job["result_format"] == "jpeg"
        assert compressed_job["result_width"] == 320
        assert compressed_job["result_height"] == 240
        assert compressed_job["result_size_bytes"] > 0
        compressed_image = client.get(compressed_job["result_image_url"])
        assert compressed_image.headers["content-type"].startswith("image/jpeg")
        compressed_output = tmp_path / "compressed.jpg"
        compressed_output.write_bytes(compressed_image.content)
        with Image.open(compressed_output) as rendered:
            assert rendered.format == "JPEG"
            assert rendered.size == (320, 240)

        invalid_resolution = client.post(
            f"/api/images/{job['id']}/process",
            json={"output_width": 640},
        )
        assert invalid_resolution.status_code == 422

        assert client.delete(f"/api/images/{job['id']}").status_code == 204


def test_rejects_disguised_image(tmp_path: Path) -> None:
    fake = tmp_path / "fake.png"
    fake.write_bytes(b"this is not a png")
    with TestClient(app) as client, fake.open("rb") as image:
        response = client.post("/api/images", files={"file": ("fake.png", image, "image/png")})
    assert response.status_code == 415
