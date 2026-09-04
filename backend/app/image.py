from __future__ import annotations

from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .schemas import AsciiSettings, ImageAsciiSettings, ImageInfo
from .video import AsciiRenderer


FORMAT_BY_PIL = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}

IMAGE_QUALITY = {
    "draft": {"jpeg": 58, "webp": 55, "png": 9},
    "balanced": {"jpeg": 80, "webp": 78, "png": 6},
    "high": {"jpeg": 92, "webp": 92, "png": 3},
}


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
) -> tuple[int, int]:
    with Image.open(input_path) as source:
        normalized = ImageOps.exif_transpose(source).convert("RGB")
        frame = cv2.cvtColor(np.asarray(normalized), cv2.COLOR_RGB2BGR)
    render_options = AsciiSettings(
        **options.model_dump(
            exclude={
                "target_character_count",
                "output_width",
                "output_height",
                "output_format",
                "quality",
                "target_size_mb",
            }
        ),
        temporal_smoothing=0.0,
    )
    renderer = AsciiRenderer(
        info.width,
        info.height,
        render_options,
        exact_character_count=options.target_character_count,
    )
    rendered, text_result = renderer.render_with_text(frame)
    if options.output_width and options.output_height:
        rendered = fit_output_frame(
            rendered,
            options.output_width,
            options.output_height,
            options.background_color,
        )
    output = Image.fromarray(cv2.cvtColor(rendered, cv2.COLOR_BGR2RGB))
    quality = IMAGE_QUALITY[options.quality]
    try:
        target_bytes = round(options.target_size_mb * 1024 * 1024) if options.target_size_mb else None
        if target_bytes and options.output_format in {"jpeg", "webp"}:
            best: bytes | None = None
            low, high = 1, 100
            while low <= high:
                candidate_quality = (low + high) // 2
                buffer = BytesIO()
                save_options = {"format": options.output_format.upper(), "quality": candidate_quality, "optimize": True}
                if options.output_format == "jpeg":
                    save_options.update(progressive=True, subsampling=2)
                else:
                    save_options.update(method=6)
                output.save(buffer, **save_options)
                payload = buffer.getvalue()
                if len(payload) <= target_bytes:
                    best = payload
                    low = candidate_quality + 1
                else:
                    high = candidate_quality - 1
            if best is None:
                raise RuntimeError("Заданный размер слишком мал для выбранного разрешения. Уменьшите разрешение или увеличьте лимит.")
            image_output_path.write_bytes(best)
        elif options.output_format == "png":
            output.save(image_output_path, format="PNG", compress_level=quality["png"], optimize=True)
            if target_bytes and image_output_path.stat().st_size > target_bytes:
                for colors in (256, 128, 64, 32, 16, 8, 4, 2):
                    quantized = output.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
                    quantized.save(image_output_path, format="PNG", compress_level=9, optimize=True)
                    if image_output_path.stat().st_size <= target_bytes:
                        break
                if image_output_path.stat().st_size > target_bytes:
                    raise RuntimeError("PNG без потерь не помещается в заданный размер. Выберите WebP или JPEG.")
        elif options.output_format == "jpeg":
            output.save(image_output_path, format="JPEG", quality=quality["jpeg"], optimize=True, progressive=True, subsampling=0 if options.quality == "high" else 2)
        else:
            output.save(image_output_path, format="WEBP", quality=quality["webp"], method=6)
    except OSError as exc:
        raise RuntimeError("Не удалось сохранить сжатое ASCII-изображение.") from exc
    text_output_path.write_text(text_result + "\n", encoding="utf-8")
    return output.size


def fit_output_frame(frame_bgr: np.ndarray, width: int, height: int, background_color: str) -> np.ndarray:
    """Resize without distortion and pad to an exact requested resolution."""
    source_height, source_width = frame_bgr.shape[:2]
    scale = min(width / source_width, height / source_height)
    fitted_width = max(1, min(width, round(source_width * scale)))
    fitted_height = max(1, min(height, round(source_height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    fitted = cv2.resize(frame_bgr, (fitted_width, fitted_height), interpolation=interpolation)
    red, green, blue = (int(background_color[index : index + 2], 16) for index in (1, 3, 5))
    canvas = np.full((height, width, 3), (blue, green, red), dtype=np.uint8)
    offset_x = (width - fitted_width) // 2
    offset_y = (height - fitted_height) // 2
    canvas[offset_y : offset_y + fitted_height, offset_x : offset_x + fitted_width] = fitted
    return canvas
