from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .config import settings
from .schemas import AsciiSettings, VideoInfo


CHARACTER_SETS = {
    "console": "@$#S%?*+;:,./\\|_- . ",
    "classic": "@%#*+=-:. ",
    "detailed": "MWNXK0Okxdolc:;,. ",
    "minimal": "@#*:. ",
    "braille": "\u2800\u28ff",
}

BRAILLE_BLANK = "\u2800"
BRAILLE_BITS = np.array(
    [
        [0x01, 0x08],
        [0x02, 0x10],
        [0x04, 0x20],
        [0x40, 0x80],
    ],
    dtype=np.uint16,
)
BRAILLE_THRESHOLDS = (
    np.array(
        [
            [0, 4],
            [6, 2],
            [3, 7],
            [5, 1],
        ],
        dtype=np.float32,
    )
    + 0.5
) * (255.0 / 8.0)

QUALITY = {
    "draft": (30, "veryfast"),
    "balanced": (23, "medium"),
    "high": (18, "slow"),
}


class ConversionCancelled(Exception):
    pass


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=False, shell=False)


@lru_cache(maxsize=4)
def _h264_encoder(binary: str) -> str:
    result = _run([binary, "-hide_banner", "-encoders"])
    encoders = result.stdout + result.stderr
    for candidate in ("libx264", "libopenh264", "h264_mf"):
        if candidate in encoders:
            return candidate
    raise RuntimeError(
        "В установленном FFmpeg нет кодера H.264. Установите полную сборку FFmpeg с libx264 или OpenH264."
    )


def _video_encoder_args(quality: str) -> list[str]:
    crf, preset = QUALITY[quality]
    encoder = _h264_encoder(settings.ffmpeg_binary)
    if encoder == "libx264":
        return ["-c:v", encoder, "-preset", preset, "-crf", str(crf)]
    bitrate = {"draft": "1500k", "balanced": "3500k", "high": "7000k"}[quality]
    return ["-c:v", encoder, "-b:v", bitrate]


def probe_video(path: Path) -> VideoInfo:
    command = [
        settings.ffprobe_binary,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    result = _run(command)
    if result.returncode != 0:
        raise ValueError("Файл не удалось прочитать как корректное MP4-видео или GIF-анимацию.")
    try:
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        video_stream = next(stream for stream in streams if stream.get("codec_type") == "video")
        rate = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "0/1"
        numerator, denominator = (float(part) for part in rate.split("/", 1))
        fps = numerator / denominator if denominator else 0.0
        duration = float(video_stream.get("duration") or data.get("format", {}).get("duration") or 0)
        width = int(video_stream["width"])
        height = int(video_stream["height"])
        rotation = video_stream.get("tags", {}).get("rotate", 0)
        for side_data in video_stream.get("side_data_list", []):
            if "rotation" in side_data:
                rotation = side_data["rotation"]
                break
        if abs(int(round(float(rotation)))) % 180 == 90:
            width, height = height, width
        return VideoInfo(
            width=width,
            height=height,
            duration=duration,
            fps=fps,
            has_audio=any(stream.get("codec_type") == "audio" for stream in streams),
        )
    except (KeyError, StopIteration, TypeError, ValueError, ZeroDivisionError) as exc:
        raise ValueError("В файле не найдена корректная видеодорожка или последовательность кадров.") from exc


def _font_path() -> str:
    candidates = [
        settings.font_path,
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError(
        "Не найден моноширинный шрифт. Укажите ASCII_FONT_PATH; в Docker используется DejaVu Sans Mono."
    )


def _font_supports_braille(path: str) -> bool:
    try:
        font = ImageFont.truetype(path, 16)
        braille_mask = font.getmask("\u28ff")
        missing_mask = font.getmask(chr(0x10FFFF))
        return braille_mask.getbbox() is not None and (
            braille_mask.size != missing_mask.size or bytes(braille_mask) != bytes(missing_mask)
        )
    except (OSError, ValueError):
        return False


def _braille_font_path() -> str:
    candidates = [
        settings.font_path,
        "C:/Windows/Fonts/seguisym.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and _font_supports_braille(candidate):
            return candidate
    raise RuntimeError(
        "Не найден шрифт с символами Unicode Braille. На Windows используется Segoe UI Symbol, "
        "а в Docker/Linux — DejaVu Sans."
    )


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


class AsciiRenderer:
    def __init__(
        self,
        source_width: int,
        source_height: int,
        options: AsciiSettings,
        exact_character_count: int | None = None,
    ):
        self.options = options
        is_braille = options.character_set == "braille"
        self.font = ImageFont.truetype(_braille_font_path() if is_braille else _font_path(), options.character_size)
        metric_sample = "\u28ff" if is_braille else "@"
        bbox_sample = "\u28ff" if is_braille else "Ag"
        self.cell_width = max(1, math.ceil(self.font.getlength(metric_sample)))
        bbox = self.font.getbbox(bbox_sample)
        self.glyph_height = bbox[3] - bbox[1]
        self.baseline_offset = -bbox[1]
        self.cell_height = max(options.character_size + 2, self.glyph_height + 2)
        character_ratio = self.cell_width / self.cell_height
        self.row_lengths: list[int] | None = None
        if exact_character_count is not None:
            rows_per_column = (source_height / source_width) * character_ratio
            self.rows = max(1, min(exact_character_count, round(math.sqrt(exact_character_count * rows_per_column))))
            base_columns, longer_rows = divmod(exact_character_count, self.rows)
            self.row_lengths = [base_columns + (1 if row < longer_rows else 0) for row in range(self.rows)]
            self.columns = max(self.row_lengths)
        else:
            self.columns = options.grid_width
            self.rows = max(1, round((source_height / source_width) * self.columns * character_ratio))
        self.width = self.columns * self.cell_width
        self.height = self.rows * self.cell_height
        if self.width % 2:
            self.width += 1
        if self.height % 2:
            self.height += 1
        self.palette = CHARACTER_SETS[options.character_set]
        self.previous_luma: np.ndarray | None = None
        self.last_text = ""

    def render(self, frame_bgr: np.ndarray, use_temporal_smoothing: bool = True) -> np.ndarray:
        if self.options.character_set == "braille":
            return self._render_braille(frame_bgr, use_temporal_smoothing)
        if self.row_lengths is not None:
            return self._render_exact(frame_bgr)
        sampled = cv2.resize(frame_bgr, (self.columns, self.rows), interpolation=cv2.INTER_AREA)
        luma = cv2.cvtColor(sampled, cv2.COLOR_BGR2GRAY).astype(np.float32)
        if self.options.normalize_contrast and float(luma.max() - luma.min()) > 1.0:
            luma = cv2.normalize(luma, None, 0, 255, cv2.NORM_MINMAX)
        luma = np.clip(luma * self.options.contrast + self.options.brightness, 0, 255)
        if self.options.invert:
            luma = 255 - luma
        smoothing = self.options.temporal_smoothing if use_temporal_smoothing else 0.0
        if smoothing and self.previous_luma is not None:
            luma = self.previous_luma * smoothing + luma * (1 - smoothing)
        self.previous_luma = luma.copy()

        indices = np.rint((255 - luma) / 255 * (len(self.palette) - 1)).astype(np.int32)
        lines = ["".join(self.palette[index] for index in indices[row]) for row in range(self.rows)]
        self.last_text = "\n".join(lines)
        canvas = Image.new("RGB", (self.width, self.height), _hex_to_rgb(self.options.background_color))
        draw = ImageDraw.Draw(canvas)
        y_padding = max(0, (self.cell_height - self.glyph_height) // 2) + self.baseline_offset

        if self.options.mode == "monochrome":
            fill = _hex_to_rgb(self.options.character_color)
            for row, line in enumerate(lines):
                draw.text((0, row * self.cell_height + y_padding), line, font=self.font, fill=fill)
        else:
            sampled_rgb = cv2.cvtColor(sampled, cv2.COLOR_BGR2RGB)
            for row in range(self.rows):
                y = row * self.cell_height + y_padding
                for column in range(self.columns):
                    character = self.palette[indices[row, column]]
                    if character != " ":
                        draw.text(
                            (column * self.cell_width, y),
                            character,
                            font=self.font,
                            fill=tuple(int(value) for value in sampled_rgb[row, column]),
                        )
        return cv2.cvtColor(np.asarray(canvas), cv2.COLOR_RGB2BGR)

    def _render_braille(self, frame_bgr: np.ndarray, use_temporal_smoothing: bool) -> np.ndarray:
        source_height = frame_bgr.shape[0]
        row_lengths = self.row_lengths or [self.columns] * self.rows
        grayscale_rows: list[np.ndarray] = []
        color_rows: list[np.ndarray] = []

        for row, length in enumerate(row_lengths):
            start_y = math.floor(row * source_height / self.rows)
            end_y = max(start_y + 1, math.floor((row + 1) * source_height / self.rows))
            band = frame_bgr[start_y : min(end_y, source_height)]
            sampled = cv2.resize(band, (length * 2, 4), interpolation=cv2.INTER_AREA)
            grayscale_rows.append(cv2.cvtColor(sampled, cv2.COLOR_BGR2GRAY).astype(np.float32))
            color_rows.append(sampled.reshape(4, length, 2, 3).mean(axis=(0, 2)))

        luma_values = np.concatenate([row.ravel() for row in grayscale_rows])
        if self.options.normalize_contrast and float(luma_values.max() - luma_values.min()) > 1.0:
            low = float(luma_values.min())
            luma_values = (luma_values - low) * (255.0 / float(luma_values.max() - low))
        luma_values = np.clip(luma_values * self.options.contrast + self.options.brightness, 0, 255)
        if self.options.invert:
            luma_values = 255 - luma_values
        smoothing = self.options.temporal_smoothing if use_temporal_smoothing else 0.0
        if smoothing and self.previous_luma is not None and self.previous_luma.shape == luma_values.shape:
            luma_values = self.previous_luma * smoothing + luma_values * (1 - smoothing)
        self.previous_luma = luma_values.copy()

        lines: list[str] = []
        codes_by_row: list[np.ndarray] = []
        offset = 0
        for length in row_lengths:
            value_count = length * 8
            density = luma_values[offset : offset + value_count].reshape(4, length, 2)
            active_dots = density > BRAILLE_THRESHOLDS[:, np.newaxis, :]
            codes = np.sum(active_dots * BRAILLE_BITS[:, np.newaxis, :], axis=(0, 2)).astype(np.uint16)
            codes_by_row.append(codes)
            lines.append("".join(BRAILLE_BLANK if code == 0 else chr(0x2800 + int(code)) for code in codes))
            offset += value_count
        self.last_text = "\n".join(lines)

        canvas = Image.new("RGB", (self.width, self.height), _hex_to_rgb(self.options.background_color))
        draw = ImageDraw.Draw(canvas)
        y_padding = max(0, (self.cell_height - self.glyph_height) // 2) + self.baseline_offset
        if self.options.mode == "monochrome":
            fill = _hex_to_rgb(self.options.character_color)
            for row, line in enumerate(lines):
                draw.text((0, row * self.cell_height + y_padding), line, font=self.font, fill=fill)
        else:
            for row, (codes, colors) in enumerate(zip(codes_by_row, color_rows, strict=True)):
                y = row * self.cell_height + y_padding
                for column, code in enumerate(codes):
                    if code:
                        color_bgr = colors[column]
                        draw.text(
                            (column * self.cell_width, y),
                            chr(0x2800 + int(code)),
                            font=self.font,
                            fill=tuple(int(value) for value in color_bgr[::-1]),
                        )
        return cv2.cvtColor(np.asarray(canvas), cv2.COLOR_RGB2BGR)

    def _render_exact(self, frame_bgr: np.ndarray) -> np.ndarray:
        assert self.row_lengths is not None
        source_height = frame_bgr.shape[0]
        sampled_rows: list[np.ndarray] = []
        for row, length in enumerate(self.row_lengths):
            start_y = math.floor(row * source_height / self.rows)
            end_y = max(start_y + 1, math.floor((row + 1) * source_height / self.rows))
            band = frame_bgr[start_y : min(end_y, source_height)]
            sampled_rows.append(cv2.resize(band, (length, 1), interpolation=cv2.INTER_AREA)[0])

        luma_values = np.concatenate(
            [cv2.cvtColor(sampled[np.newaxis, :, :], cv2.COLOR_BGR2GRAY)[0] for sampled in sampled_rows]
        ).astype(np.float32)
        if self.options.normalize_contrast and float(luma_values.max() - luma_values.min()) > 1.0:
            low = float(luma_values.min())
            luma_values = (luma_values - low) * (255.0 / float(luma_values.max() - low))
        luma_values = np.clip(luma_values * self.options.contrast + self.options.brightness, 0, 255)
        if self.options.invert:
            luma_values = 255 - luma_values
        indices = np.rint((255 - luma_values) / 255 * (len(self.palette) - 1)).astype(np.int32)

        index_rows: list[np.ndarray] = []
        lines: list[str] = []
        offset = 0
        for length in self.row_lengths:
            row_indices = indices[offset : offset + length]
            index_rows.append(row_indices)
            lines.append("".join(self.palette[index] for index in row_indices))
            offset += length
        self.last_text = "\n".join(lines)

        canvas = Image.new("RGB", (self.width, self.height), _hex_to_rgb(self.options.background_color))
        draw = ImageDraw.Draw(canvas)
        y_padding = max(0, (self.cell_height - self.glyph_height) // 2) + self.baseline_offset
        if self.options.mode == "monochrome":
            fill = _hex_to_rgb(self.options.character_color)
            for row, line in enumerate(lines):
                draw.text((0, row * self.cell_height + y_padding), line, font=self.font, fill=fill)
        else:
            for row, (sampled, row_indices) in enumerate(zip(sampled_rows, index_rows, strict=True)):
                sampled_rgb = cv2.cvtColor(sampled[np.newaxis, :, :], cv2.COLOR_BGR2RGB)[0]
                y = row * self.cell_height + y_padding
                for column, character_index in enumerate(row_indices):
                    character = self.palette[character_index]
                    if character != " ":
                        draw.text(
                            (column * self.cell_width, y),
                            character,
                            font=self.font,
                            fill=tuple(int(value) for value in sampled_rgb[column]),
                        )
        return cv2.cvtColor(np.asarray(canvas), cv2.COLOR_RGB2BGR)

    def render_with_text(self, frame_bgr: np.ndarray) -> tuple[np.ndarray, str]:
        rendered = self.render(frame_bgr, use_temporal_smoothing=False)
        return rendered, self.last_text


def create_preview(input_path: Path, output_path: Path, info: VideoInfo, options: AsciiSettings, timestamp: float) -> None:
    safe_timestamp = min(max(0.0, timestamp), max(0.0, info.duration - 0.05))
    decoded = subprocess.run(
        [
            settings.ffmpeg_binary,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-ss",
            f"{safe_timestamp:.3f}",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ],
        capture_output=True,
        check=False,
        shell=False,
    )
    expected_bytes = info.width * info.height * 3
    if decoded.returncode != 0 or len(decoded.stdout) < expected_bytes:
        details = decoded.stderr.decode("utf-8", errors="replace")
        raise ValueError(f"Не удалось извлечь выбранный кадр для предпросмотра. {details[-300:]}")
    frame = np.frombuffer(decoded.stdout[:expected_bytes], dtype=np.uint8).reshape((info.height, info.width, 3))
    renderer = AsciiRenderer(info.width, info.height, options)
    rendered = renderer.render(frame, use_temporal_smoothing=False)
    if not cv2.imwrite(str(output_path), rendered):
        raise RuntimeError("Не удалось сохранить предпросмотр.")


def _read_exact(stream, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def convert_video(
    input_path: Path,
    output_path: Path,
    work_dir: Path,
    info: VideoInfo,
    options: AsciiSettings,
    cancelled: Callable[[], bool],
    progress: Callable[[str, int], None],
) -> None:
    renderer = AsciiRenderer(info.width, info.height, options)
    is_gif_output = options.output_format == "gif"
    encoded_path = work_dir / ("encoded-animation.gif" if is_gif_output else "encoded-video.mp4")
    expected_frames = max(1, math.ceil(info.duration * options.fps))
    decoding_command = [
        settings.ffmpeg_binary,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-an",
        "-vf",
        f"fps={options.fps}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]
    encoding_command = [
        settings.ffmpeg_binary,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{renderer.width}x{renderer.height}",
        "-r",
        str(options.fps),
        "-i",
        "-",
        "-an",
    ]
    if is_gif_output:
        encoding_command.extend(
            [
                "-filter_complex",
                "[0:v]split[gif_a][gif_b];[gif_a]palettegen=stats_mode=single[palette];[gif_b][palette]paletteuse=new=1:dither=sierra2_4a:diff_mode=rectangle",
                "-loop",
                "0",
                str(encoded_path),
            ]
        )
    else:
        encoding_command.extend(_video_encoder_args(options.quality))
        encoding_command.extend(
            [
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(encoded_path),
            ]
        )
    decoder = subprocess.Popen(
        decoding_command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
    )
    encoder = subprocess.Popen(
        encoding_command,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
    )
    output_index = 0
    source_frame_bytes = info.width * info.height * 3
    progress("extracting", 15)

    try:
        assert decoder.stdout is not None
        assert encoder.stdin is not None
        while True:
            if cancelled():
                raise ConversionCancelled()
            raw_frame = _read_exact(decoder.stdout, source_frame_bytes)
            if not raw_frame:
                break
            if len(raw_frame) != source_frame_bytes:
                raise RuntimeError("FFmpeg вернул неполный кадр при декодировании.")
            frame = np.frombuffer(raw_frame, dtype=np.uint8).reshape((info.height, info.width, 3))
            rendered = renderer.render(frame)
            encoder.stdin.write(rendered.tobytes())
            output_index += 1
            percent = 20 + int(65 * output_index / expected_frames)
            progress("converting", min(85, percent))

        if output_index == 0:
            raise ValueError("В видео не удалось прочитать ни одного кадра.")
        encoder.stdin.close()
        decoder_stderr = decoder.stderr.read().decode("utf-8", errors="replace") if decoder.stderr else ""
        decoder_code = decoder.wait()
        encoder_stderr = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
        encoder_code = encoder.wait()
        if decoder_code != 0:
            raise RuntimeError(f"FFmpeg не смог декодировать файл: {decoder_stderr[-600:]}")
        if encoder_code != 0:
            raise RuntimeError(f"FFmpeg не смог собрать видеоряд: {encoder_stderr[-600:]}")
    except (BrokenPipeError, OSError) as exc:
        stderr = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
        raise RuntimeError(f"FFmpeg прервал кодирование: {stderr[-600:]}") from exc
    finally:
        for process in (decoder, encoder):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()

    if cancelled():
        raise ConversionCancelled()
    progress("assembling", 90)
    if is_gif_output:
        shutil.move(str(encoded_path), str(output_path))
        progress("assembling", 98)
        return
    if options.keep_audio and info.has_audio:
        mux = _run(
            [
                settings.ffmpeg_binary,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(encoded_path),
                "-i",
                str(input_path),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
        )
        if mux.returncode != 0:
            raise RuntimeError(f"Не удалось перенести звуковую дорожку: {mux.stderr[-600:]}")
        encoded_path.unlink(missing_ok=True)
    else:
        shutil.move(str(encoded_path), str(output_path))
    progress("assembling", 98)
