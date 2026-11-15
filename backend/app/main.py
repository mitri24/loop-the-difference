import re
from datetime import datetime
from typing import Annotated

from astropy.coordinates.name_resolve import NameResolveError
from astropy.time import Time
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from redis.exceptions import RedisError

from app import jobs, names, partners, smallbodies, surprise, tracks
from app.archive import (
    ArchiveError,
    collection_key,
    resolve_position,
    search_observations,
    spherex_collections,
    summarize,
)
from app.catalogs import find_proper_motion
from app.config import Settings, get_settings
from app.coords import CoordinateError, parse_dec, parse_ra
from app.models import (
    FingerprintJob,
    FingerprintRequest,
    FollowupJob,
    FollowupRequest,
    FrameJob,
    FrameManifest,
    FrameRequest,
    ObservationSummary,
    PairDifferenceJob,
    PairDifferenceRequest,
    ResolvedTarget,
    SpectrumJob,
    SpectrumRequest,
    SurpriseTarget,
)
from app.smallbodies import router as smallbodies_router
from app.tasks import manifest_path

_JOB_ID = re.compile(r"^[0-9a-f]{16}$")
_FRAME_FILE = re.compile(
    r"^((?:preview_\d{3}_)?frame_\d{2}|diff_\d{2}_\d{2}|pair(?:sig|diff)_\d{2}_\d{2}_v\d+)\.png$"
)

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
    return ResolvedTarget(
        name=name,
        ra=ra,
        dec=dec,
        proper_motion=find_proper_motion(ra, dec, cache_dir=settings.cache_dir),
    )


@app.get("/api/surprise", response_model_exclude_none=True)
def surprise_target(settings: SettingsDep) -> SurpriseTarget:
    return surprise.pick(settings)


@app.get("/api/observations")
def observations(ra: str, dec: str, settings: SettingsDep) -> ObservationSummary:
    ra_deg, dec_deg = parse_ra(ra), parse_dec(dec)
    collections = spherex_collections(settings)
    found, _ = search_observations(ra_deg, dec_deg, settings, collections)
    return summarize(ra_deg, dec_deg, collection_key(collections), found)


@app.post("/api/frames")
def create_frames(request: FrameRequest, settings: SettingsDep) -> FrameJob:
    ra, dec = parse_ra(request.ra), parse_dec(request.dec)
    collections = spherex_collections(settings)
    job_id = jobs.job_id_for(
        collection_key(collections),
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
        collections=collections,
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


@app.post("/api/difference")
def create_difference(request: PairDifferenceRequest, settings: SettingsDep) -> PairDifferenceJob:
    folder = manifest_path(settings.cache_dir, request.job_id).parent
    if not (folder / "manifest.json").is_file():
        raise HTTPException(
            status_code=404, detail="The comparison's final images are not there: load it again"
        )
    count = len(FrameManifest.model_validate_json((folder / "manifest.json").read_text()).frames)
    if max(request.a, request.b) >= count:
        raise HTTPException(status_code=422, detail=f"A and B must be frames 0 to {count - 1}")
    redis = jobs.connect(settings.redis_url)
    lookup = request.small_bodies_job and smallbodies.status(redis, request.small_bodies_job)
    return jobs.submit_difference(
        redis, settings, request.job_id, request.a, request.b, lookup or None
    )


@app.get("/api/difference/{job_id}")
def difference_job(job_id: str, settings: SettingsDep) -> PairDifferenceJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.difference_status(jobs.connect(settings.redis_url), settings, job_id)


@app.post("/api/spectrum")
def create_spectrum(request: SpectrumRequest, settings: SettingsDep) -> SpectrumJob:
    ra, dec = parse_ra(request.ra), parse_dec(request.dec)
    return jobs.submit_spectrum(jobs.connect(settings.redis_url), settings, ra, dec)


@app.get("/api/spectrum/{job_id}")
def spectrum_job(job_id: str, settings: SettingsDep) -> SpectrumJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.spectrum_status(jobs.connect(settings.redis_url), job_id)


@app.post("/api/followup")
def create_followup(request: FollowupRequest, settings: SettingsDep) -> FollowupJob:
    return jobs.submit_followup(jobs.connect(settings.redis_url), settings, _track(request))


def _track(request: FollowupRequest) -> dict:
    """A follow-up's parameters as the worker takes them (followup.plan)."""
    params = {
        "ra": parse_ra(request.ra),
        "dec": parse_dec(request.dec),
        "detector": request.detector,
        "marked": [[f.obs_id, _mjd(f.date), _mjd(f.date_end)] for f in request.marked],
    }
    if request.grid is not None:
        marks, distances = tracks.grid(request.grid)
        params |= {"marks": marks.tolist(), "distances": distances.tolist()}
    else:
        params["points"] = [[p.mjd, p.ra, p.dec, p.radius_arcsec] for p in request.points]
    return params


def _mjd(moment: datetime | None) -> float | None:
    return None if moment is None else float(Time(moment).mjd)


# The spectrum along one track of a follow-up: its request plus distance_au (app/fingerprint.py).
@app.post("/api/followup/fingerprint")
def create_fingerprint(request: FingerprintRequest, settings: SettingsDep) -> FingerprintJob:
    params = _track(request)
    if request.grid is not None:
        params["distances"] = [request.distance_au]
    return jobs.submit_fingerprint(jobs.connect(settings.redis_url), settings, params)


@app.get("/api/followup/fingerprint/{job_id}")
def fingerprint_job(job_id: str, settings: SettingsDep) -> FingerprintJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.fingerprint_status(jobs.connect(settings.redis_url), job_id)


@app.get("/api/followup/{job_id}")
def followup_job(job_id: str, settings: SettingsDep) -> FollowupJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return jobs.followup_status(jobs.connect(settings.redis_url), job_id)


app.include_router(smallbodies_router)
