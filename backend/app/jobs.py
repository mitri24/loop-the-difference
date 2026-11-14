import hashlib
from contextlib import suppress
from functools import lru_cache

from redis import Redis
from rq import Queue
from rq.exceptions import NoSuchJobError
from rq.job import Job, JobStatus

from app.config import Settings
from app.models import FrameJob, FrameManifest, Spectrum, SpectrumJob
from app.tasks import (
    PIPELINE_VERSION,
    SPECTRUM_VERSION,
    build_frames,
    build_spectrum,
    manifest_path,
)

QUEUE_NAME = "frames"
JOB_TIMEOUT_S = 900


class QueueFull(Exception):
    """More than SKYSHIFT_MAX_QUEUED jobs are waiting; nothing was enqueued."""


def job_id_for(
    collection: str,
    ra: float,
    dec: float,
    size_deg: float,
    detector: int,
    max_frames: int,
    stack: bool = False,
) -> str:
    """Same request → same job id, so repeated requests share one job and one cache entry."""
    key = f"{collection}|{ra:.5f}|{dec:.5f}|{size_deg:.4f}|{detector}|{max_frames}"
    if stack:
        key += "|stack"
    key += f"|v{PIPELINE_VERSION}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


@lru_cache
def connect(url: str, socket_timeout: float | None = 5.0) -> Redis:
    return Redis.from_url(url, socket_connect_timeout=2, socket_timeout=socket_timeout)


def submit(redis: Redis, settings: Settings, job_id: str, **params: float | int | bool) -> FrameJob:
    current = status(redis, settings, job_id)
    if current.status in ("queued", "started"):
        return current
    if current.status == "finished" and current.manifest and current.manifest.complete:
        return current
    queue = Queue(QUEUE_NAME, connection=redis)
    if queue.count > settings.max_queued:
        raise QueueFull()
    # Failed, expired or incomplete: start over (downloaded cutouts stay cached).
    manifest_path(settings.cache_dir, job_id).unlink(missing_ok=True)
    with suppress(NoSuchJobError):
        Job.fetch(job_id, connection=redis).delete()
    queue.enqueue(
        build_frames,
        kwargs={"key": job_id, **params},
        job_id=job_id,
        job_timeout=JOB_TIMEOUT_S,
        result_ttl=3600,
        failure_ttl=600,
    )
    return FrameJob(job_id=job_id, status="queued")


def spectrum_job_id(collection: str, ra: float, dec: float) -> str:
    key = f"spectrum|{collection}|{ra:.5f}|{dec:.5f}|v{SPECTRUM_VERSION}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def submit_spectrum(redis: Redis, settings: Settings, ra: float, dec: float) -> SpectrumJob:
    """Like `submit`, but the spectrum is small: it lives in the job result, not in the cache."""
    job_id = spectrum_job_id(settings.spherex_collection, ra, dec)
    current = spectrum_status(redis, job_id)
    if current.status in ("queued", "started"):
        return current
    if current.status == "finished" and current.spectrum and current.spectrum.complete:
        return current
    queue = Queue(QUEUE_NAME, connection=redis)
    if queue.count > settings.max_queued:
        raise QueueFull()
    with suppress(NoSuchJobError):
        Job.fetch(job_id, connection=redis).delete()
    queue.enqueue(
        build_spectrum,
        kwargs={"ra": ra, "dec": dec},
        job_id=job_id,
        job_timeout=JOB_TIMEOUT_S,
        result_ttl=86400,
        failure_ttl=600,
    )
    return SpectrumJob(job_id=job_id, status="queued")


def spectrum_status(redis: Redis, job_id: str) -> SpectrumJob:
    try:
        job = Job.fetch(job_id, connection=redis)
    except NoSuchJobError:
        return SpectrumJob(job_id=job_id, status="not_found")
    state = job.get_status()
    if state == JobStatus.FINISHED:
        result = job.return_value()
        if result is None:
            return SpectrumJob(job_id=job_id, status="not_found")
        return SpectrumJob(
            job_id=job_id, status="finished", spectrum=Spectrum.model_validate(result)
        )
    if state in (JobStatus.QUEUED, JobStatus.STARTED):
        running = "started" if state == JobStatus.STARTED else "queued"
        progress, total = int(job.meta.get("progress", 0)), int(job.meta.get("total", 0))
        return SpectrumJob(job_id=job_id, status=running, progress=progress, total=total)
    # Failed, stopped or cancelled (e.g. a worker restart): the next request starts it again.
    error = _last_error(job) if state == JobStatus.FAILED else f"Spectrum job {state.value}"
    return SpectrumJob(job_id=job_id, status="failed", error=error)


def status(redis: Redis, settings: Settings, job_id: str) -> FrameJob:
    cached = manifest_path(settings.cache_dir, job_id)
    if cached.is_file():
        manifest = FrameManifest.model_validate_json(cached.read_text())
        return FrameJob(job_id=job_id, status="finished", manifest=manifest)
    try:
        job = Job.fetch(job_id, connection=redis)
    except NoSuchJobError:
        return FrameJob(job_id=job_id, status="not_found")
    progress = int(job.meta.get("progress", 0))
    total = int(job.meta.get("total", 0))
    state = job.get_status()
    if state == JobStatus.FAILED:
        return FrameJob(job_id=job_id, status="failed", error=_last_error(job))
    if state == JobStatus.FINISHED:
        return FrameJob(job_id=job_id, status="not_found")
    running = "started" if state == JobStatus.STARTED else "queued"
    return FrameJob(job_id=job_id, status=running, progress=progress, total=total)


def _last_error(job: Job) -> str:
    result = job.latest_result()
    lines = (
        [line for line in (result.exc_string or "").splitlines() if line.strip()] if result else []
    )
    return lines[-1] if lines else "Frame job failed"
