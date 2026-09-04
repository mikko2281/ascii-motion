from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .schemas import AsciiSettings, ImageAsciiSettings, ImageInfo
from .video import AsciiRenderer


FORMAT_BY_PIL = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}


def inspect_image(path: Path) -> ImageInfo:
    try:
        with Image.open(path) as source:
            source.verify()
        with Image.open(path) as source:
            width, height = ImageOps.exif_transpose(source).size
            image_format = FORMAT_BY_PIL.get(source.format or "")
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ValueError("Файл не удалось прочитать как корректное изображение.") from exc
    if not image_format:
        raise ValueError("Поддерживаются только изображения PNG, JPG и WebP.")
    if width <= 0 or height <= 0 or width * height > 40_000_000:
        raise ValueError("Разрешение изображения превышает безопасный предел 40 мегапикселей.")
    return ImageInfo(width=width, height=height, format=image_format)


def convert_image(
    input_path: Path,
    image_output_path: Path,
    text_output_path: Path,
    info: ImageInfo,
    options: ImageAsciiSettings,
) -> None:
    with Image.open(input_path) as source:
        normalized = ImageOps.exif_transpose(source).convert("RGB")
        frame = cv2.cvtColor(np.asarray(normalized), cv2.COLOR_RGB2BGR)
    render_options = AsciiSettings(
        **options.model_dump(exclude={"target_character_count"}),
        temporal_smoothing=0.0,
    )
    renderer = AsciiRenderer(
        info.width,
        info.height,
        render_options,
        exact_character_count=options.target_character_count,
    )
    rendered, text_result = renderer.render_with_text(frame)
    if not cv2.imwrite(str(image_output_path), rendered, [cv2.IMWRITE_PNG_COMPRESSION, 6]):
        raise RuntimeError("Не удалось сохранить ASCII-изображение.")
    text_output_path.write_text(text_result + "\n", encoding="utf-8")
