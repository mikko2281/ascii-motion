from __future__ import annotations

import asyncio
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .config import settings
from .image import convert_image, inspect_image
from .remote import RemoteDownloadError, download_remote
from .schemas import (
    AsciiSettings,
    ImageAsciiSettings,
    ImageInfo,
    ImageJobResponse,
    JobResponse,
    PreviewRequest,
    UrlImportRequest,
    VideoInfo,
)
from .video import ConversionCancelled, convert_video, create_preview, probe_video


@dataclass
class Job:
    id: str
    directory: Path
    input_path: Path
    info: VideoInfo
    status: str = "ready"
    stage: str = "uploaded"
    progress: int = 10
    message: str | None = None
    preview_path: Path | None = None
    result_path: Path | None = None
    result_format: str | None = None
    result_width: int | None = None
    result_height: int | None = None
    result_size_bytes: int | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task[None] | None = None


@dataclass
class ImageJob:
    id: str
    directory: Path
    input_path: Path
    info: ImageInfo
    status: str = "ready"
    message: str | None = None
    result_image_path: Path | None = None
    result_text_path: Path | None = None
    result_format: str | None = None
    result_width: int | None = None
    result_height: int | None = None
    result_size_bytes: int | None = None



@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.temp_root.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="ASCII Motion API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
jobs: dict[str, Job] = {}
image_jobs: dict[str, ImageJob] = {}


def public_job(job: Job) -> JobResponse:
    return JobResponse(
        id=job.id,
        status=job.status,
        stage=job.stage,
        progress=job.progress,
        message=job.message,
        video=job.info,
        source_url=f"/api/jobs/{job.id}/source" if job.input_path.exists() else None,
        source_format=job.input_path.suffix.lstrip(".") if job.input_path.suffix in {".mp4", ".gif"} else None,
        preview_url=f"/api/jobs/{job.id}/preview?t={time.time_ns()}" if job.preview_path else None,
        result_url=f"/api/jobs/{job.id}/result" if job.result_path else None,
        result_format=job.result_format,
        result_width=job.result_width,
        result_height=job.result_height,
        result_size_bytes=job.result_size_bytes,
    )


def get_job(job_id: str) -> Job:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Задача не найдена или уже удалена.")
    return job


def public_image_job(job: ImageJob) -> ImageJobResponse:
    cache_key = time.time_ns()
    return ImageJobResponse(
        id=job.id,
        status=job.status,
        message=job.message,
        image=job.info,
        source_url=f"/api/images/{job.id}/source",
        result_image_url=f"/api/images/{job.id}/result?format={job.result_format}&t={cache_key}" if job.result_image_path else None,
        result_text_url=f"/api/images/{job.id}/result?format=txt&t={cache_key}" if job.result_text_path else None,
        result_format=job.result_format,
        result_width=job.result_width,
        result_height=job.result_height,
        result_size_bytes=job.result_size_bytes,
    )


def get_image_job(job_id: str) -> ImageJob:
    job = image_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Задача изображения не найдена или уже удалена.")
    return job


SUPPORTED_UPLOADS = {
    ".mp4": {"video/mp4", "application/mp4", "application/octet-stream"},
    ".gif": {"image/gif", "application/octet-stream"},
}

SUPPORTED_IMAGES = {
    ".png": ({"image/png", "application/octet-stream"}, "png"),
    ".jpg": ({"image/jpeg", "application/octet-stream"}, "jpeg"),
    ".jpeg": ({"image/jpeg", "application/octet-stream"}, "jpeg"),
    ".webp": ({"image/webp", "application/octet-stream"}, "webp"),
}


def validate_media_header(extension: str, header: bytes) -> bool:
    if extension == ".mp4":
        return len(header) >= 12 and b"ftyp" in header[:64]
    if extension == ".gif":
        return header.startswith((b"GIF87a", b"GIF89a"))
    return False


def validate_image_header(extension: str, header: bytes) -> bool:
    if extension == ".png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    if extension in {".jpg", ".jpeg"}:
        return header.startswith(b"\xff\xd8\xff")
    if extension == ".webp":
        return len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WEBP"
    return False


def detect_media_extension(header: bytes) -> str | None:
    for extension in (".mp4", ".gif"):
        if validate_media_header(extension, header):
            return extension
    return None


def detect_image_extension(header: bytes) -> str | None:
    for extension in (".png", ".jpg", ".webp"):
        if validate_image_header(extension, header):
            return extension
    return None


@app.get("/api/health")
def health() -> dict[str, object]:
    error = settings.media_tools_error()
    return {
        "ok": error is None,
        "message": error,
        "limits": {
            "max_upload_mb": settings.max_upload_mb,
            "max_image_upload_mb": settings.max_image_upload_mb,
            "max_duration_seconds": settings.max_duration_seconds,
        },
    }


@app.post("/api/images", response_model=ImageJobResponse, status_code=201)
async def create_image_job(file: UploadFile = File(...)) -> ImageJobResponse:
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_IMAGES:
        raise HTTPException(status_code=415, detail="Поддерживаются изображения PNG, JPG и WebP.")
    accepted_mimes, expected_format = SUPPORTED_IMAGES[extension]
    if file.content_type not in accepted_mimes:
        raise HTTPException(status_code=415, detail=f"MIME-тип не соответствует формату {expected_format.upper()}.")

    job_id = uuid.uuid4().hex
    directory = settings.temp_root / f"image-{job_id}"
    directory.mkdir(parents=True, exist_ok=False)
    input_path = directory / f"input{extension}"
    total = 0
    header = bytearray()
    try:
        with input_path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > settings.max_image_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Изображение превышает лимит {settings.max_image_upload_mb} МБ.",
                    )
                if len(header) < 64:
                    header.extend(chunk[: 64 - len(header)])
                destination.write(chunk)
        if not validate_image_header(extension, bytes(header)):
            raise HTTPException(status_code=415, detail=f"Сигнатура файла не соответствует {expected_format.upper()}.")
        info = await asyncio.to_thread(inspect_image, input_path)
        if info.format != expected_format:
            raise HTTPException(status_code=415, detail="Содержимое изображения не соответствует его расширению.")
        job = ImageJob(id=job_id, directory=directory, input_path=input_path, info=info)
        image_jobs[job_id] = job
        return public_image_job(job)
    except HTTPException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except ValueError as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Не удалось сохранить изображение.") from exc
    finally:
        await file.close()


@app.post("/api/images/url", response_model=ImageJobResponse, status_code=201)
async def create_image_job_from_url(request: UrlImportRequest) -> ImageJobResponse:
    job_id = uuid.uuid4().hex
    directory = settings.temp_root / f"image-{job_id}"
    directory.mkdir(parents=True, exist_ok=False)
    download_path = directory / "remote-download"
    try:
        downloaded = await download_remote(request.url, download_path, settings.max_image_upload_bytes)
        extension = detect_image_extension(downloaded.header)
        if not extension:
            raise HTTPException(status_code=415, detail="Ссылка должна вести прямо на PNG, JPG или WebP.")
        input_path = directory / f"input{extension}"
        shutil.move(str(download_path), str(input_path))
        info = await asyncio.to_thread(inspect_image, input_path)
        job = ImageJob(id=job_id, directory=directory, input_path=input_path, info=info)
        image_jobs[job_id] = job
        return public_image_job(job)
    except HTTPException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except (RemoteDownloadError, ValueError) as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Не удалось импортировать изображение по ссылке.") from exc


@app.get("/api/images/{job_id}", response_model=ImageJobResponse)
def get_image_job_status(job_id: str) -> ImageJobResponse:
    return public_image_job(get_image_job(job_id))


@app.get("/api/images/{job_id}/source")
def get_image_source(job_id: str) -> FileResponse:
    job = get_image_job(job_id)
    media_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    return FileResponse(job.input_path, media_type=media_types[job.input_path.suffix], headers={"Cache-Control": "no-store"})


@app.post("/api/images/{job_id}/process", response_model=ImageJobResponse)
async def process_image_job(job_id: str, options: ImageAsciiSettings) -> ImageJobResponse:
    job = get_image_job(job_id)
    image_result = job.directory / f"ascii-image.{options.output_format}"
    text_result = job.directory / "ascii-image.txt"
    try:
        for old_result in job.directory.glob("ascii-image.*"):
            if old_result.name != text_result.name:
                old_result.unlink(missing_ok=True)
        result_width, result_height = await asyncio.to_thread(
            convert_image,
            job.input_path,
            image_result,
            text_result,
            job.info,
            options,
        )
        job.result_image_path = image_result
        job.result_text_path = text_result
        job.result_format = options.output_format
        job.result_width = result_width
        job.result_height = result_height
        job.result_size_bytes = image_result.stat().st_size
        job.status = "completed"
        job.message = None
        return public_image_job(job)
    except (ValueError, RuntimeError, OSError) as exc:
        image_result.unlink(missing_ok=True)
        text_result.unlink(missing_ok=True)
        job.result_image_path = None
        job.result_text_path = None
        job.result_format = None
        job.result_width = None
        job.result_height = None
        job.result_size_bytes = None
        job.status = "error"
        job.message = str(exc) or "Не удалось преобразовать изображение."
        raise HTTPException(status_code=422, detail=job.message) from exc


@app.get("/api/images/{job_id}/result")
def get_image_result(
    job_id: str,
    format: Literal["png", "jpeg", "webp", "txt"] = "png",
    download: bool = False,
    t: str | None = None,
) -> FileResponse:
    del t
    job = get_image_job(job_id)
    if format == "txt":
        result_path = job.result_text_path
    elif format == job.result_format:
        result_path = job.result_image_path
    else:
        result_path = None
    if not result_path or not result_path.exists():
        raise HTTPException(status_code=404, detail="Результат ещё не создан.")
    response_options = {
        "path": result_path,
        "media_type": {
            "png": "image/png",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "txt": "text/plain; charset=utf-8",
        }[format],
        "headers": {"Cache-Control": "no-store"},
    }
    if download:
        response_options["filename"] = "ascii-image.txt" if format == "txt" else f"ascii-image.{format}"
    return FileResponse(**response_options)


@app.delete("/api/images/{job_id}", status_code=204, response_class=Response)
def delete_image_job(job_id: str) -> Response:
    job = get_image_job(job_id)
    image_jobs.pop(job_id, None)
    shutil.rmtree(job.directory, ignore_errors=True)
    return Response(status_code=204)


@app.post("/api/jobs", response_model=JobResponse, status_code=201)
async def create_job(file: UploadFile = File(...)) -> JobResponse:
    media_error = settings.media_tools_error()
    if media_error:
        raise HTTPException(status_code=503, detail=media_error)
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_UPLOADS:
        raise HTTPException(status_code=415, detail="Поддерживаются только файлы MP4 и GIF.")
    if file.content_type not in SUPPORTED_UPLOADS[extension]:
        raise HTTPException(status_code=415, detail=f"MIME-тип файла не соответствует формату {extension[1:].upper()}.")

    job_id = uuid.uuid4().hex
    directory = settings.temp_root / job_id
    directory.mkdir(parents=True, exist_ok=False)
    input_path = directory / f"input{extension}"
    total = 0
    header = bytearray()
    try:
        with input_path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл превышает лимит {settings.max_upload_mb} МБ.",
                    )
                if len(header) < 64:
                    header.extend(chunk[: 64 - len(header)])
                destination.write(chunk)
        if not validate_media_header(extension, bytes(header)):
            raise HTTPException(
                status_code=415,
                detail=f"Сигнатура файла не соответствует формату {extension[1:].upper()}.",
            )
        info = await asyncio.to_thread(probe_video, input_path)
        if info.duration <= 0:
            raise HTTPException(status_code=422, detail="Не удалось определить длительность видео.")
        if info.duration > settings.max_duration_seconds:
            raise HTTPException(
                status_code=413,
                detail=f"Файл длиннее допустимых {settings.max_duration_seconds // 60} минут.",
            )
        job = Job(id=job_id, directory=directory, input_path=input_path, info=info)
        jobs[job_id] = job
        return public_job(job)
    except HTTPException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except ValueError as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Не удалось сохранить загруженное видео.") from exc
    finally:
        await file.close()


@app.post("/api/jobs/url", response_model=JobResponse, status_code=201)
async def create_job_from_url(request: UrlImportRequest) -> JobResponse:
    media_error = settings.media_tools_error()
    if media_error:
        raise HTTPException(status_code=503, detail=media_error)
    job_id = uuid.uuid4().hex
    directory = settings.temp_root / job_id
    directory.mkdir(parents=True, exist_ok=False)
    download_path = directory / "remote-download"
    try:
        downloaded = await download_remote(request.url, download_path, settings.max_upload_bytes)
        extension = detect_media_extension(downloaded.header)
        if not extension:
            raise HTTPException(status_code=415, detail="Ссылка должна вести прямо на MP4 или анимированный GIF.")
        input_path = directory / f"input{extension}"
        shutil.move(str(download_path), str(input_path))
        info = await asyncio.to_thread(probe_video, input_path)
        if info.duration <= 0:
            raise HTTPException(status_code=422, detail="Не удалось определить длительность файла по ссылке.")
        if info.duration > settings.max_duration_seconds:
            raise HTTPException(
                status_code=413,
                detail=f"Файл длиннее допустимых {settings.max_duration_seconds // 60} минут.",
            )
        job = Job(id=job_id, directory=directory, input_path=input_path, info=info)
        jobs[job_id] = job
        return public_job(job)
    except HTTPException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except (RemoteDownloadError, ValueError) as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Не удалось импортировать видео по ссылке.") from exc


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job_status(job_id: str) -> JobResponse:
    return public_job(get_job(job_id))


@app.get("/api/jobs/{job_id}/source")
def get_job_source(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if not job.input_path.exists():
        raise HTTPException(status_code=410, detail="Исходный файл уже удалён после обработки.")
    media_type = "image/gif" if job.input_path.suffix == ".gif" else "video/mp4"
    return FileResponse(job.input_path, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.post("/api/jobs/{job_id}/preview", response_model=JobResponse)
async def make_preview(job_id: str, options: PreviewRequest) -> JobResponse:
    job = get_job(job_id)
    if job.status == "processing":
        raise HTTPException(status_code=409, detail="Дождитесь завершения обработки или отмените её.")
    if not job.input_path.exists():
        raise HTTPException(status_code=410, detail="Исходник уже удалён после завершения задачи.")
    output = job.directory / "preview.png"
    try:
        await asyncio.to_thread(create_preview, job.input_path, output, job.info, options, options.timestamp)
        job.preview_path = output
        job.message = None
        return public_job(job)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def run_conversion(job: Job, options: AsciiSettings) -> None:
    def update(stage: str, progress: int) -> None:
        job.stage = stage
        job.progress = progress

    try:
        output_path = job.directory / f"ascii-result.{options.output_format}"
        result_width, result_height = convert_video(
            job.input_path,
            output_path,
            job.directory,
            job.info,
            options,
            job.cancel_event.is_set,
            update,
        )
        job.result_path = output_path
        job.result_format = options.output_format
        job.result_width = result_width
        job.result_height = result_height
        job.result_size_bytes = output_path.stat().st_size
        job.status = "completed"
        job.stage = "completed"
        job.progress = 100
        job.message = None
    except ConversionCancelled:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.message = "Обработка отменена."
    except Exception as exc:
        job.status = "error"
        job.stage = "error"
        job.message = str(exc) or "Ошибка обработки видео."
    finally:
        job.input_path.unlink(missing_ok=True)
        (job.directory / "encoded-video.mp4").unlink(missing_ok=True)
        (job.directory / "encoded-animation.gif").unlink(missing_ok=True)
        if job.status != "completed":
            (job.directory / "ascii-result.mp4").unlink(missing_ok=True)
            (job.directory / "ascii-result.gif").unlink(missing_ok=True)


@app.post("/api/jobs/{job_id}/process", response_model=JobResponse, status_code=202)
async def process_job(job_id: str, options: AsciiSettings) -> JobResponse:
    job = get_job(job_id)
    if job.status == "processing":
        raise HTTPException(status_code=409, detail="Эта задача уже обрабатывается.")
    if not job.input_path.exists():
        raise HTTPException(status_code=410, detail="Исходник уже удалён; загрузите видео заново.")
    job.cancel_event.clear()
    job.status = "processing"
    job.stage = "extracting"
    job.progress = 12
    job.message = None
    job.task = asyncio.create_task(asyncio.to_thread(run_conversion, job, options))
    return public_job(job)


@app.post("/api/jobs/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: str) -> JobResponse:
    job = get_job(job_id)
    if job.status == "processing":
        job.cancel_event.set()
        job.stage = "cancelling"
        job.message = "Останавливаем обработку…"
    return public_job(job)


@app.get("/api/jobs/{job_id}/preview")
def get_preview(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if not job.preview_path or not job.preview_path.exists():
        raise HTTPException(status_code=404, detail="Предпросмотр ещё не создан.")
    return FileResponse(job.preview_path, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{job_id}/result")
def get_result(job_id: str, inline: bool = False) -> FileResponse:
    job = get_job(job_id)
    if not job.result_path or not job.result_path.exists():
        raise HTTPException(status_code=404, detail="Готовое видео ещё недоступно.")
    response_options = {
        "path": job.result_path,
        "media_type": "image/gif" if job.result_format == "gif" else "video/mp4",
        "headers": {"Cache-Control": "no-store"},
    }
    if not inline:
        response_options["filename"] = "ascii-animation.gif" if job.result_format == "gif" else "ascii-video.mp4"
    return FileResponse(**response_options)


@app.delete("/api/jobs/{job_id}", status_code=204, response_class=Response)
async def delete_job(job_id: str) -> Response:
    job = get_job(job_id)
    if job.status == "processing":
        job.cancel_event.set()
        if job.task:
            try:
                await asyncio.wait_for(job.task, timeout=30)
            except asyncio.TimeoutError as exc:
                raise HTTPException(status_code=409, detail="Задача ещё останавливается. Повторите удаление.") from exc
    jobs.pop(job_id, None)
    shutil.rmtree(job.directory, ignore_errors=True)
    return Response(status_code=204)


@app.get("/")
def root(request: Request) -> dict[str, str]:
    return {"message": "ASCII Motion API", "docs": str(request.base_url) + "docs"}
