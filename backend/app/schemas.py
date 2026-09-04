from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class AsciiSettings(BaseModel):
    grid_width: int = Field(96, ge=32, le=240)
    character_size: int = Field(10, ge=8, le=20)
    contrast: float = Field(1.2, ge=0.5, le=3.0)
    brightness: int = Field(0, ge=-100, le=100)
    invert: bool = False
    character_color: str = "#e9ecef"
    background_color: str = "#050607"
    character_set: Literal["console", "classic", "detailed", "minimal", "braille"] = "console"
    fps: int = Field(20, ge=6, le=60)
    quality: Literal["draft", "balanced", "high"] = "balanced"
    output_format: Literal["mp4", "gif"] = "mp4"
    keep_audio: bool = True
    mode: Literal["monochrome", "original_colors"] = "monochrome"
    normalize_contrast: bool = True
    temporal_smoothing: float = Field(0.2, ge=0.0, le=0.85)
    output_width: int | None = Field(None, ge=1)
    output_height: int | None = Field(None, ge=1)
    target_size_mb: float | None = Field(None, gt=0)

    @model_validator(mode="after")
    def validate_output_resolution(self) -> "AsciiSettings":
        if (self.output_width is None) != (self.output_height is None):
            raise ValueError("Для разрешения результата укажите одновременно ширину и высоту.")
        return self

    @field_validator("character_color", "background_color")
    @classmethod
    def validate_hex_color(cls, value: str) -> str:
        if len(value) != 7 or value[0] != "#":
            raise ValueError("Цвет должен быть в формате #RRGGBB")
        try:
            int(value[1:], 16)
        except ValueError as exc:
            raise ValueError("Цвет должен быть в формате #RRGGBB") from exc
        return value.lower()


class PreviewRequest(AsciiSettings):
    timestamp: float = Field(0.0, ge=0.0)


class ImageAsciiSettings(BaseModel):
    grid_width: int = Field(96, ge=32, le=240)
    target_character_count: int | None = Field(None, ge=100, le=100_000)
    character_size: int = Field(10, ge=8, le=24)
    contrast: float = Field(1.2, ge=0.5, le=3.0)
    brightness: int = Field(0, ge=-100, le=100)
    invert: bool = False
    character_color: str = "#e9ecef"
    background_color: str = "#050607"
    character_set: Literal["console", "classic", "detailed", "minimal", "braille"] = "console"
    mode: Literal["monochrome", "original_colors"] = "monochrome"
    normalize_contrast: bool = True
    output_width: int | None = Field(None, ge=1)
    output_height: int | None = Field(None, ge=1)
    output_format: Literal["png", "jpeg", "webp"] = "png"
    quality: Literal["draft", "balanced", "high"] = "balanced"
    target_size_mb: float | None = Field(None, gt=0)

    @model_validator(mode="after")
    def validate_output_resolution(self) -> "ImageAsciiSettings":
        if (self.output_width is None) != (self.output_height is None):
            raise ValueError("Для разрешения результата укажите одновременно ширину и высоту.")
        return self

    @field_validator("character_color", "background_color")
    @classmethod
    def validate_hex_color(cls, value: str) -> str:
        return AsciiSettings.validate_hex_color(value)


class VideoInfo(BaseModel):
    width: int
    height: int
    duration: float
    fps: float
    has_audio: bool


class ImageInfo(BaseModel):
    width: int
    height: int
    format: Literal["png", "jpeg", "webp"]


class ImageJobResponse(BaseModel):
    id: str
    status: Literal["ready", "completed", "error"]
    message: str | None = None
    image: ImageInfo
    source_url: str
    result_image_url: str | None = None
    result_text_url: str | None = None
    result_format: Literal["png", "jpeg", "webp"] | None = None
    result_width: int | None = None
    result_height: int | None = None
    result_size_bytes: int | None = None


class UrlImportRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


class JobResponse(BaseModel):
    id: str
    status: str
    stage: str
    progress: int
    message: str | None = None
    video: VideoInfo | None = None
    source_url: str | None = None
    source_format: Literal["mp4", "gif"] | None = None
    preview_url: str | None = None
    result_url: str | None = None
    result_format: Literal["mp4", "gif"] | None = None
    result_width: int | None = None
    result_height: int | None = None
    result_size_bytes: int | None = None
