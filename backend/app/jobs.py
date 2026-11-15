import hashlib
import json
import re
from collections.abc import Callable
from contextlib import suppress
from functools import lru_cache

from redis import Redis
from rq import Queue
from rq.exceptions import NoSuchJobError
from rq.job import Job, JobStatus

from app import followup
from app.archive import collection_key, spherex_collections
from app.config import Settings
from app.models import FollowupJob, FrameJob, FrameManifest, SpectrumJob
from app.tasks import (
    PIPELINE_VERSION,
    SPECTRUM_VERSION,
    build_followup,
    build_frames,
    build_spectrum,
    manifest_path,
)

QUEUE_NAME = "frames"
# Jobs that take minutes (spectra, follow-ups) run on a worker of their own, so they never delay
# a frame job.
SLOW_QUEUE = "slow"
JOB_TIMEOUT_S = 900
# A cold spectrum downloads up to MAX_SPECTRUM_POINTS cutouts; IRSA alone took ~30 min for 200.
SPECTRUM_TIMEOUT_S = 1800


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


def submit(
    redis: Redis, settings: Settings, job_id: str, **params: float | int | bool | list[str]
) -> FrameJob:
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
    (manifest_path(settings.cache_dir, job_id).parent / "preview.json").unlink(missing_ok=True)
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
    collections = spherex_collections(settings)
    job_id = spectrum_job_id(collection_key(collections), ra, dec)
    kwargs = {"ra": ra, "dec": dec, "collections": collections}
    return _submit_result(
        redis, settings, SpectrumJob, job_id, build_spectrum, kwargs, SPECTRUM_TIMEOUT_S
    )


def spectrum_status(redis: Redis, job_id: str) -> SpectrumJob:
    return _result_status(redis, SpectrumJob, job_id)


def followup_job_id(collection: str, params: dict) -> str:
    key = f"followup|{collection}|{json.dumps(params, sort_keys=True)}|v{followup.VERSION}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def submit_followup(redis: Redis, settings: Settings, params: dict) -> FollowupJob:
    """Like `submit_spectrum`; at most followup.MAX_CUTOUTS cutouts fit the frame job timeout."""
    collections = spherex_collections(settings)
    job_id = followup_job_id(collection_key(collections), params)
    kwargs = {**params, "collections": collections}
    return _submit_result(
        redis, settings, FollowupJob, job_id, build_followup, kwargs, JOB_TIMEOUT_S
    )


def followup_status(redis: Redis, job_id: str) -> FollowupJob:
    return _result_status(redis, FollowupJob, job_id)


# Jobs whose small result lives in the job itself, with the field that holds it.
ResultJob = SpectrumJob | FollowupJob
_RESULT_FIELD = {SpectrumJob: "spectrum", FollowupJob: "followup"}


def _submit_result(
    redis: Redis,
    settings: Settings,
    model: type[ResultJob],
    job_id: str,
    function: Callable[..., dict],
    kwargs: dict,
    timeout_s: int,
) -> ResultJob:
    """A running job or a complete result is reused; anything else starts over on the slow queue."""
    current = _result_status(redis, model, job_id)
    if current.status in ("queued", "started"):
        return current
    result = getattr(current, _RESULT_FIELD[model])
    if current.status == "finished" and result and result.complete:
        return current
    queue = Queue(SLOW_QUEUE, connection=redis)
    if queue.count > settings.max_queued:
        raise QueueFull()
    with suppress(NoSuchJobError):
        Job.fetch(job_id, connection=redis).delete()
    queue.enqueue(
        function,
        kwargs=kwargs,
        job_id=job_id,
        job_timeout=timeout_s,
        result_ttl=86400,
        failure_ttl=600,
    )
    return model(job_id=job_id, status="queued")


def _result_status(redis: Redis, model: type[ResultJob], job_id: str) -> ResultJob:
    field = _RESULT_FIELD[model]
    try:
        job = Job.fetch(job_id, connection=redis)
    except NoSuchJobError:
        return model(job_id=job_id, status="not_found")
    state = job.get_status()
    if state == JobStatus.FINISHED:
        result = job.return_value()
        if result is None:
            return model(job_id=job_id, status="not_found")
        return model(job_id=job_id, status="finished", **{field: result})
    if state in (JobStatus.QUEUED, JobStatus.STARTED):
        running = "started" if state == JobStatus.STARTED else "queued"
        progress, total = int(job.meta.get("progress", 0)), int(job.meta.get("total", 0))
        return model(job_id=job_id, status=running, progress=progress, total=total)
    # Failed, stopped or cancelled (e.g. a worker restart): the next request starts it again.
    error = (
        _last_error(job) if state == JobStatus.FAILED else f"{field.capitalize()} job {state.value}"
    )
    return model(job_id=job_id, status="failed", error=error)


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
    preview_path = cached.parent / "preview.json"
    preview = (
        FrameManifest.model_validate_json(preview_path.read_text())
        if preview_path.is_file()
        else None
    )
    if state == JobStatus.FAILED:
        return FrameJob(job_id=job_id, status="failed", error=_last_error(job), manifest=preview)
    if state == JobStatus.FINISHED:
        return FrameJob(job_id=job_id, status="not_found")
    running = "started" if state == JobStatus.STARTED else "queued"
    return FrameJob(job_id=job_id, status=running, progress=progress, total=total, manifest=preview)


_EXCEPTION_PREFIX = re.compile(r"^[A-Za-z_][\w.]*(?:Error|Exception): ")


def error_text(line: str) -> str:
    """An exception line without its class: "app.archive.ArchiveError: X" → "X"."""
    return _EXCEPTION_PREFIX.sub("", line, count=1)


def _last_error(job: Job) -> str:
    result = job.latest_result()
    lines = (
        [line for line in (result.exc_string or "").splitlines() if line.strip()] if result else []
    )
    # The message, not the traceback's "app.archive.ArchiveError: " in front of it.
    return error_text(lines[-1]) if lines else "Frame job failed"
