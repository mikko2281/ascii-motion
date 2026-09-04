from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    max_upload_mb: int = _int("MAX_UPLOAD_MB", 200)
    max_image_upload_mb: int = _int("MAX_IMAGE_UPLOAD_MB", 20)
    max_duration_seconds: int = _int("MAX_DURATION_SECONDS", 300)
    temp_root: Path = Path(os.getenv("TEMP_ROOT", tempfile.gettempdir())) / "ascii-motion"
    ffmpeg_binary: str = os.getenv("FFMPEG_BINARY", "ffmpeg")
    ffprobe_binary: str = os.getenv("FFPROBE_BINARY", "ffprobe")
    font_path: str | None = os.getenv("ASCII_FONT_PATH")
    frontend_origin: str = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def max_image_upload_bytes(self) -> int:
        return self.max_image_upload_mb * 1024 * 1024

    def media_tools_error(self) -> str | None:
        missing: list[str] = []
        for label, executable in (("FFmpeg", self.ffmpeg_binary), ("FFprobe", self.ffprobe_binary)):
            if not (Path(executable).is_file() or shutil.which(executable)):
                missing.append(label)
        if not missing:
            return None
        names = " и ".join(missing)
        return (
            f"Не найдены {names}. Установите FFmpeg и добавьте папку bin в PATH, "
            "либо задайте FFMPEG_BINARY и FFPROBE_BINARY в .env. Подробные команды есть в README.md."
        )


settings = Settings()
