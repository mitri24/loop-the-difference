"""Tiny in-process job runner with progress, for long downloads (blink, spectrum).

The frontend POSTs a job, then polls ``GET /api/jobs/{id}``. Jobs live in memory:
fine for one server process (the hackathon deployment). For several workers, swap
this for Redis/RQ — the API contract stays the same.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from .schemas import JobStatus
from .validation import InputError

log = logging.getLogger(__name__)

_JOBS: dict[str, JobStatus] = {}
_TASKS: set[asyncio.Task] = set()
_CREATED: dict[str, float] = {}
MAX_AGE_S = 3600


def start(kind: str, work: Callable[[Callable[[float, str], None]], Awaitable]) -> JobStatus:
    _gc()
    job = JobStatus(
        id=uuid.uuid4().hex[:16], kind=kind, state="queued", progress=0.0, message="Queued"
    )
    _JOBS[job.id] = job
    _CREATED[job.id] = time.time()

    def progress(p: float, msg: str) -> None:
        job.state = "running"
        job.progress = max(job.progress, min(1.0, p))
        job.message = msg

    async def runner() -> None:
        try:
            job.state = "running"
            job.result = await work(progress)
            job.state, job.progress, job.message = "done", 1.0, "Done"
        except InputError as exc:
            job.state, job.error, job.message = "error", exc.message, "Invalid input"
        except Exception as exc:
            log.exception("job %s failed", job.id)
            job.state, job.error, job.message = "error", f"{type(exc).__name__}: {exc}", "Failed"

    task = asyncio.create_task(runner())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return job


def get(job_id: str) -> JobStatus | None:
    return _JOBS.get(job_id)


def _gc() -> None:
    now = time.time()
    for jid, t in list(_CREATED.items()):
        if now - t > MAX_AGE_S:
            _JOBS.pop(jid, None)
            _CREATED.pop(jid, None)
