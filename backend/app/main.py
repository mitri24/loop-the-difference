import re
from typing import Annotated

from astropy.coordinates.name_resolve import NameResolveError
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from redis.exceptions import RedisError

from app import jobs, names, partners, tracks
from app.archive import ArchiveError, resolve_position, search_observations, summarize
from app.catalogs import find_proper_motion
from app.config import Settings, get_settings
from app.coords import CoordinateError, parse_dec, parse_ra
from app.models import (
    FrameJob,
    FrameRequest,
    ObservationSummary,
    ResolvedTarget,
    SpectrumJob,
    SpectrumRequest,
)
from app.smallbodies import router as smallbodies_router

_JOB_ID = re.compile(r"^[0-9a-f]{16}$")
_FRAME_FILE = re.compile(r"^(frame_\d{2}|diff_\d{2}_\d{2})\.png$")

SettingsDep = Annotated[Settings, Depends(get_settings)]

app = FastAPI(title="Loop the Difference API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.include_router(partners.router)
app.include_router(tracks.router)


# FastAPI's default answer echoes the input; NaN or Infinity there cannot be written as JSON (500).
@app.exception_handler(RequestValidationError)
def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{key: value for key, value in e.items() if key != "input"} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


@app.exception_handler(CoordinateError)
def coordinate_error(_: Request, exc: CoordinateError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(ArchiveError)
def archive_error(_: Request, exc: ArchiveError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RedisError)
def queue_error(_: Request, __: RedisError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": "Job queue is not available"})


@app.exception_handler(jobs.QueueFull)
def queue_full(_: Request, __: jobs.QueueFull) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": "Busy – please try again in a minute"})


@app.get("/api/health")
def health(settings: SettingsDep) -> dict[str, str]:
    try:
        jobs.connect(settings.redis_url).ping()
        queue = "ok"
    except RedisError:
        queue = "unavailable"
    return {"status": "ok", "redis": queue, "collection": settings.spherex_collection}


# No Gaia match: proper_motion is left out of the answer.
@app.get("/api/resolve", response_model_exclude_none=True)
def resolve(
    settings: SettingsDep, name: str = Query(min_length=1, max_length=100)
) -> ResolvedTarget:
    try:
        ra, dec = resolve_position(name, settings)
    except NameResolveError:
        raise HTTPException(status_code=404, detail=f"Unknown target: {name}") from None
    except names.NameLookupTimeout:
        raise HTTPException(
            status_code=504, detail="Name lookup timed out – try coordinates"
        ) from None
    return ResolvedTarget(name=name, ra=ra, dec=dec, proper_motion=find_proper_motion(ra, dec))


@app.get("/api/observations")
def observations(ra: str, dec: str, settings: SettingsDep) -> ObservationSummary:
    ra_deg, dec_deg = parse_ra(ra), parse_dec(dec)
    found = search_observations(ra_deg, dec_deg, settings)
    return summarize(ra_deg, dec_deg, settings.spherex_collection, found)


@app.post("/api/frames")
def create_frames(request: FrameRequest, settings: SettingsDep) -> FrameJob:
    ra, dec = parse_ra(request.ra), parse_dec(request.dec)
    job_id = jobs.job_id_for(
        settings.spherex_collection,
        ra,
        dec,
        request.size_deg,
        request.detector,
        request.max_frames,
        request.stack,
    )
    return jobs.submit(
        jobs.connect(settings.redis_url),
        settings,
        job_id,
        ra=ra,
        dec=dec,
        size_deg=request.size_deg,
        detector=request.detector,
        max_frames=request.max_frames,
        stack=request.stack,
    )


@app.get("/api/frames/{job_id}")
def frame_job(job_id: str, settings: SettingsDep) -> FrameJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.status(jobs.connect(settings.redis_url), settings, job_id)


@app.get("/api/frames/{job_id}/{filename}")
def frame_file(job_id: str, filename: str, settings: SettingsDep) -> FileResponse:
    path = settings.cache_dir / "frames" / job_id / filename
    if not (_JOB_ID.match(job_id) and _FRAME_FILE.match(filename) and path.is_file()):
        raise HTTPException(status_code=404, detail="Unknown frame")
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400, immutable"}
    )


@app.post("/api/spectrum")
def create_spectrum(request: SpectrumRequest, settings: SettingsDep) -> SpectrumJob:
    ra, dec = parse_ra(request.ra), parse_dec(request.dec)
    return jobs.submit_spectrum(jobs.connect(settings.redis_url), settings, ra, dec)


@app.get("/api/spectrum/{job_id}")
def spectrum_job(job_id: str, settings: SettingsDep) -> SpectrumJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.spectrum_status(jobs.connect(settings.redis_url), job_id)


app.include_router(smallbodies_router)
