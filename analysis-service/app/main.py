"""FastAPI application: REST API under /api, built frontend served at /.

Run:  uv run uvicorn app.main:app --reload --port 8000
Docs: http://localhost:8000/docs (OpenAPI)
"""

from __future__ import annotations

import logging
import math
import re
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import analysis, jobs, releases
from .astrometry import propagate
from .catalogs import (
    ResolveError,
    allwise_cone,
    cadc_images,
    cadc_motion_check,
    catwise_cone,
    gaia_cone,
    resolve_name,
)
from .config import settings
from .irsa import find_observations, search_checks
from .schemas import (
    CadcSearch,
    CatalogSource,
    DifferenceRequest,
    DifferenceResult,
    JobStatus,
    ObservationSearch,
    SequenceRequest,
    Target,
)
from .spectral import BANDS
from .targets import DEMO_TARGETS, find_demo
from .validation import InputError, parse_dec, parse_fov, parse_ra

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="SPHEREx Time-Domain Explorer API",
    version="0.1.0",
    description="Finds real SPHEREx observations (NASA/IPAC IRSA), aligns them and "
    "builds blink, difference and spectrum views with evidence checks.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(InputError)
async def _input_error(_, exc: InputError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"code": exc.code, "detail": exc.message})


# Sky layers for Aladin Lite. Direct service URLs (not CDS IDs) so the viewer does not
# depend on the CDS registry; IRSA mirrors first (the CDS alasky tile server was down on
# 2026-11-12/13 — see QUALITY.md). `cube` layers expose a wavelength slider.
_CDS = "https://alasky.cds.unistra.fr"
_IRSA_HIPS = "https://irsa.ipac.caltech.edu/data/hips"
# SPHEREx maps published by IRSA are DISCOVERED at run time (app/releases.py) and listed
# first, newest first. The layers below are static extras: CDS SPHEREx QR2 maps and
# comparison surveys (IRSA mirrors).
STATIC_HIPS = [
    {
        "id": "cds-spherex-color",
        "url": f"{_CDS}/SPHEREx/color",
        "label": "SPHEREx QR2 colour (CDS)",
        "cube": False,
    },
    *[
        {
            "id": f"cds-spherex-{b.lower()}",
            "url": f"{_CDS}/SPHEREx/{b}",
            "label": f"SPHEREx QR2 {b} {i.lam_min_um:.2f}-{i.lam_max_um:.2f} µm (CDS)",
            "cube": False,
        }
        for b, i in BANDS.items()
    ],
    {
        "id": "2mass",
        "url": f"{_IRSA_HIPS}/CDS/2MASS/Color",
        "label": "2MASS colour (comparison)",
        "cube": False,
    },
    {
        "id": "allwise",
        "url": f"{_IRSA_HIPS}/CDS/AllWISE/RGB-W4-W2-W1",
        "label": "AllWISE colour (comparison)",
        "cube": False,
    },
    {
        "id": "dss2",
        "url": f"{_IRSA_HIPS}/CDS/DSS2/color",
        "label": "DSS2 optical (comparison)",
        "cube": False,
    },
]


def _releases_payload(state: releases.ReleaseState) -> dict:
    return {
        "collections": [releases.describe(c) for c in state.collections],
        "source": state.source,
        "checked_at": datetime.fromtimestamp(state.checked_at, UTC).isoformat()
        if state.checked_at
        else None,
        "refresh_every_hours": settings.release_refresh_s / 3600,
        "error": state.error,
    }


@app.get("/api/health")
async def health() -> dict:
    state = await releases.get_state()
    return {"status": "ok", "collections": state.collections}


@app.get("/api/releases")
async def get_releases(refresh: bool = False) -> dict:
    """SPHEREx releases in use. `?refresh=true` re-checks IRSA immediately."""
    return _releases_payload(await releases.get_state(force=refresh))


@app.get("/api/config")
async def config() -> dict:
    state = await releases.get_state()
    return {
        "collections": state.collections,
        "releases": _releases_payload(state),
        "bands": {b: i.__dict__ for b, i in BANDS.items()},
        "fov": {
            "min": settings.min_fov_arcmin,
            "max": settings.max_fov_arcmin,
            "default": settings.default_fov_arcmin,
        },
        "pixel_arcsec": settings.native_pixel_arcsec,
        "hips": [*state.hips, *STATIC_HIPS],
        "demo_targets": [
            {
                "slug": slug,
                "label": d["label"],
                "why": d["why"],
                "suggested_band": d["suggested_band"],
                "target": d["target"].model_dump(),
            }
            for slug, d in DEMO_TARGETS.items()
        ],
    }


@app.get("/api/resolve", response_model=Target)
async def resolve(name: str = Query(..., min_length=1, max_length=80)) -> Target:
    async with httpx.AsyncClient() as client:
        try:
            return await resolve_name(name, client)
        except (ResolveError, httpx.HTTPError, ValueError) as exc:
            demo = find_demo(name)
            if demo is not None:
                return demo
            raise HTTPException(404, f"Could not resolve {name!r}: {exc}") from exc


@app.get("/api/observations", response_model=ObservationSearch)
async def observations(
    ra: str,
    dec: str,
    fov: float | None = None,
    name: str | None = None,
    pm_ra: float | None = None,
    pm_dec: float | None = None,
    epoch: float = 2000.0,
) -> ObservationSearch:
    t = Target(
        name=name,
        ra=parse_ra(ra),
        dec=parse_dec(dec),
        epoch_jyear=epoch,
        pm_ra_mas_yr=pm_ra,
        pm_dec_mas_yr=pm_dec,
    )
    fov_arcmin = parse_fov(fov)
    ra_e, dec_e = analysis.target_at(t, analysis.SEARCH_EPOCH_JYEAR)
    obs, visits, checks, urls = await find_observations(ra_e, dec_e, fov_arcmin / 60)
    return ObservationSearch(
        target=t,
        ra_epoch=ra_e,
        dec_epoch=dec_e,
        epoch_jyear=analysis.SEARCH_EPOCH_JYEAR,
        fov_arcmin=fov_arcmin,
        collections=await releases.current_collections(),
        observations=obs,
        visits=visits,
        checks=checks + search_checks(obs, visits),
        query_urls=urls,
    )


@app.post("/api/jobs/sequence", response_model=JobStatus)
async def start_sequence(req: SequenceRequest) -> JobStatus:
    # Validate synchronously so bad input fails fast with 422.
    analysis.target_from_request(req)
    parse_fov(req.fov_arcmin)
    return jobs.start("sequence", lambda p: analysis.run_sequence(req, p))


class SpectrumRequest(BaseModel):
    ra: str | float
    dec: str | float
    name: str | None = None
    pm_ra_mas_yr: float | None = None
    pm_dec_mas_yr: float | None = None
    target_epoch_jyear: float = 2000.0
    max_frames: int = 120


@app.post("/api/jobs/spectrum", response_model=JobStatus)
async def start_spectrum(req: SpectrumRequest) -> JobStatus:
    t = Target(
        name=req.name,
        ra=parse_ra(req.ra),
        dec=parse_dec(req.dec),
        epoch_jyear=req.target_epoch_jyear,
        pm_ra_mas_yr=req.pm_ra_mas_yr,
        pm_dec_mas_yr=req.pm_dec_mas_yr,
    )
    n = max(10, min(req.max_frames, 400))
    return jobs.start("spectrum", lambda p: analysis.run_spectrum(t, n, p))


@app.get("/api/jobs/{job_id}", response_model=JobStatus)
async def job_status(job_id: str) -> JobStatus:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown or expired job")
    return job


@app.post("/api/difference", response_model=DifferenceResult)
async def make_difference(req: DifferenceRequest) -> DifferenceResult:
    try:
        return await analysis.difference(req.frame_a, req.frame_b, req.force)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


class SolarSystemRequest(BaseModel):
    diff_id: str


@app.post("/api/jobs/solar-system", response_model=JobStatus)
async def start_solar_system(req: SolarSystemRequest) -> JobStatus:
    """Known asteroids/comets (JPL SBIdent) for a difference already computed. Slow."""
    if req.diff_id not in analysis.DIFFS:
        raise HTTPException(404, "Difference not found (expired). Compare the frames again.")
    return jobs.start("solar_system", lambda p: analysis.run_solar_system_check(req.diff_id, p))


class CadcRequest(BaseModel):
    ra: str | float
    dec: str | float
    name: str | None = None
    pm_ra_mas_yr: float | None = None
    pm_dec_mas_yr: float | None = None
    target_epoch_jyear: float = 2000.0
    fov_arcmin: float | None = None


@app.post("/api/jobs/cadc", response_model=JobStatus)
async def start_cadc(req: CadcRequest) -> JobStatus:
    """Images of the field from other telescopes at the CADC (Canada), incl. NEOSSat. 2-20 s."""
    t = Target(
        name=req.name,
        ra=parse_ra(req.ra),
        dec=parse_dec(req.dec),
        epoch_jyear=req.target_epoch_jyear,
        pm_ra_mas_yr=req.pm_ra_mas_yr,
        pm_dec_mas_yr=req.pm_dec_mas_yr,
    )
    radius_deg = parse_fov(req.fov_arcmin) / 2 / 60
    ra_e, dec_e = analysis.target_at(t, analysis.SEARCH_EPOCH_JYEAR)

    async def work(progress) -> CadcSearch:
        progress(0.1, "Querying the Canadian Astronomy Data Centre")
        async with httpx.AsyncClient(follow_redirects=True) as client:
            res = await cadc_images(ra_e, dec_e, radius_deg, client)
        pm = math.hypot(t.pm_ra_mas_yr or 0.0, t.pm_dec_mas_yr or 0.0) / 1000  # arcsec/yr
        note = cadc_motion_check(pm, analysis.SEARCH_EPOCH_JYEAR, res.collections)
        return res.model_copy(update={"checks": [*res.checks, note]}) if note else res

    return jobs.start("cadc", work)


_FILE_ID = re.compile(r"^[0-9a-f]{20}(_sig)?\.(png|fits)$")


@app.get("/api/frames/{filename}")
async def frame_file(filename: str) -> FileResponse:
    if not _FILE_ID.match(filename):
        raise HTTPException(400, "Bad frame file name")
    path = settings.frame_cache / filename
    if not path.exists():
        raise HTTPException(404, "Frame not found")
    media = "image/png" if filename.endswith(".png") else "application/fits"
    return FileResponse(
        path,
        media_type=media,
        headers={"Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*"},
    )


@app.get("/api/catalog", response_model=list[CatalogSource])
async def catalog(
    ra: str,
    dec: str,
    radius_arcmin: float = Query(5.0, gt=0, le=30),
    # catwise: CatWISE2020 positions at each source's mean epoch, motions only above 3σ
    # (the sky view moves AllWISE's red sources with them to each frame's time).
    catalog: str = Query("gaia", pattern="^(gaia|allwise|catwise)$"),
    epoch: float | None = Query(None, description="Propagate positions to this Julian year"),
) -> list[CatalogSource]:
    ra_d, dec_d = parse_ra(ra), parse_dec(dec)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        try:
            fn = {"gaia": gaia_cone, "allwise": allwise_cone, "catwise": catwise_cone}[catalog]
            sources = await fn(ra_d, dec_d, radius_arcmin / 60, client)
        except (httpx.HTTPError, ValueError) as exc:  # ValueError: IRSA answered without a table
            raise HTTPException(502, f"{catalog} service unavailable: {exc}") from exc
    if epoch is None or catalog != "gaia":
        return sources
    out = []
    for s in sources:
        r, d = propagate(s.ra, s.dec, s.pm_ra_mas_yr, s.pm_dec_mas_yr, s.epoch_jyear, epoch)
        out.append(s.model_copy(update={"ra": r, "dec": d, "epoch_jyear": epoch}))
    return out


# ---- built frontend (production) ------------------------------------------------------
if settings.frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, "Unknown API route")
        candidate = settings.frontend_dist / path
        if path and candidate.is_file() and settings.frontend_dist in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(settings.frontend_dist / "index.html")
