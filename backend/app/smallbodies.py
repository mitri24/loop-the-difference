"""Known asteroids and comets in the field at each epoch, from NASA/JPL SBIdent (worker job).

Second pass only: the first (two-body) pass answers in about 20 s but lists coarse candidates
with position errors of degrees (none of 3338 lay in a 0.2° field); the numerically integrated
second pass took 60–110 s per epoch when measured and lists positions to 0.1″.
Observer = SPHEREx: JPL Horizons gives its geocentric position at the epoch's time (2.5 km from
the X_SC/Y_SC/Z_SC of the frame's FITS header when compared), passed to SBIdent as `xobs`. Its
velocity stays zero, so JPL's rates remain the geocentric ones the markers move along for hours;
SPHEREx's own 7.5 km/s would add up to ~25″/h for main-belt asteroids, reversing every 49 min.
Without that position an epoch is looked up for the geocentre (MPC code 500), as its source_url
shows: SPHEREx is 7,000 km from it, which shifts main-belt asteroids typically by a few ″, up to
~10″, and close near-Earth objects by arcminutes.
"""

import hashlib
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import suppress
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

import httpx
from astropy import units as u
from astropy.coordinates import Angle, angular_separation
from astropy.time import Time
from fastapi import APIRouter, Depends, HTTPException
from redis import Redis
from rq import Queue
from rq.exceptions import NoSuchJobError
from rq.job import Job, JobStatus

from app import jobs
from app.config import Settings, get_settings
from app.coords import parse_dec, parse_jpl_dec, parse_ra
from app.frames import target_grid
from app.models import SmallBodiesJob, SmallBodiesRequest, SmallBody, SmallBodyEpoch
from app.tasks import report

SBIDENT_URL = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
# "SPHEREx (spacecraft)" in JPL Horizons; its ephemeris starts at launch (2025-03-12).
SPHEREX_HORIZONS_ID = "-163182"
# Bump whenever the parsing changes: job ids and cache entries change with it.
VERSION = 2
TIMEOUT = httpx.Timeout(180.0, connect=10.0)
HORIZONS_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
# JPL answered three parallel second passes without trouble (66–113 s).
PARALLEL_EPOCHS = 3
JOB_TIMEOUT_S = 900
UNREACHABLE = "JPL SBIdent not reachable"
COLUMNS = (
    "Object name",
    "Astrometric RA (hh:mm:ss)",
    "Astrometric Dec (dd mm'ss\")",
    "Visual magnitude (V)",
    'RA rate ("/h)',
    'Dec rate ("/h)',
)
_JOB_ID = re.compile(r"^[0-9a-f]{16}$")
# Geocentric ICRF position in km.
Position = tuple[float, float, float]

router = APIRouter()
SettingsDep = Annotated[Settings, Depends(get_settings)]


def canonical_mjds(mjds: list[float]) -> list[float]:
    """Epoch times in order and without repeats, to 1 s: the same request gets the same job."""
    return sorted({round(mjd, 5) for mjd in mjds})


def job_id_for(ra: float, dec: float, size_deg: float, mjds: list[float]) -> str:
    times = ",".join(f"{mjd:.5f}" for mjd in mjds)
    key = f"smallbodies|{ra:.5f}|{dec:.5f}|{size_deg:.4f}|{times}|v{VERSION}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def sbident_observer(spherex: Position | None) -> dict[str, str]:
    """SBIdent's observer: SPHEREx's geocentric position with zero velocity, else the geocentre."""
    if spherex:
        return {"xobs": ",".join(f"{km:.3f}" for km in spherex) + ",0,0,0"}
    return {"mpc-code": "500"}


def query_params(
    ra: float, dec: float, size_deg: float, mjd: float, spherex: Position | None = None
) -> dict[str, str]:
    """An RA/Dec box around the frame; `parse_sbident` keeps what lies on the frame itself."""
    half = size_deg / 2 * 1.01
    # RA widths are coordinate degrees; the square is widest at its edge nearest the pole.
    ra_half = min(180.0, half / math.cos(math.radians(min(abs(dec) + half, 90.0))))
    dec_text = Angle(dec, u.deg).to_string(unit=u.deg, sep="-", precision=1, pad=True)
    return {
        **sbident_observer(spherex),
        "obs-time": f"{mjd + 2400000.5:.5f}",
        "fov-ra-center": Angle(ra, u.deg).to_string(unit=u.hour, sep="-", precision=2, pad=True),
        # SBIdent wants M instead of a minus sign.
        "fov-dec-center": dec_text.replace("-", "M", 1) if dec < 0 else dec_text,
        "fov-ra-hwidth": f"{ra_half:.5f}",
        "fov-dec-hwidth": f"{half:.5f}",
        "two-pass": "true",
        "suppress-first-pass": "true",
        # Keep bodies without magnitude parameters (some comets): they are known all the same.
        "mag-required": "false",
    }


def parse_sbident(payload: dict, ra: float, dec: float, size_deg: float) -> list[SmallBody]:
    """Second-pass bodies on the frame grid (frames.target_grid), brightest first.

    An empty field is stated by JPL; any other answer without rows raises, so it is not cached.
    """
    if "data_second_pass" not in payload:
        if payload.get("n_second_pass") == 0 or payload.get("warning") == "no matching records":
            return []
        raise KeyError("data_second_pass")
    rows = payload["data_second_pass"]
    if not rows:
        return []
    index = [payload["fields_second"].index(name) for name in COLUMNS]
    grid, (width, height) = target_grid(ra, dec, size_deg)
    bodies = []
    for row in rows:
        name, ra_text, dec_text, vmag, ra_rate, dec_rate = (row[i] for i in index)
        body_ra, body_dec = parse_ra(ra_text), parse_jpl_dec(dec_text)
        x, y = grid.world_to_pixel_values(body_ra, body_dec)
        if not (-0.5 <= x <= width - 0.5 and -0.5 <= y <= height - 0.5):
            continue
        separation = angular_separation(
            ra * u.deg, dec * u.deg, body_ra * u.deg, body_dec * u.deg
        ).to_value(u.arcsec)
        bodies.append(
            SmallBody(
                name=name,
                ra=body_ra,
                dec=body_dec,
                vmag=_number(vmag),
                ra_rate=float(ra_rate),
                dec_rate=float(dec_rate),
                distance_arcsec=round(float(separation), 1),
            )
        )
    return sorted(bodies, key=lambda b: (b.vmag is None, b.vmag or 0.0))


def _number(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def cache_path(cache_dir: Path, source_url: str) -> Path:
    key = hashlib.sha256(f"{source_url}|v{VERSION}".encode()).hexdigest()[:16]
    return cache_dir / "smallbodies" / f"{key}.json"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".tmp")
    partial.write_text(text)
    partial.replace(path)


def horizons_params(mjds: list[float]) -> dict[str, str]:
    """SPHEREx's geometric geocentric ICRF position (km) at the epoch times (UTC), as CSV."""
    return {
        "format": "json",
        "COMMAND": f"'{SPHEREX_HORIZONS_ID}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'",
        "CENTER": "'500@399'",
        "REF_PLANE": "'FRAME'",
        "REF_SYSTEM": "'ICRF'",
        "OUT_UNITS": "'KM-S'",
        "VEC_TABLE": "'1'",
        "VEC_CORR": "'NONE'",
        "CSV_FORMAT": "'YES'",
        "TIME_TYPE": "'UT'",
        "TLIST_TYPE": "'MJD'",
        "TLIST": " ".join(f"'{mjd:.5f}'" for mjd in mjds),
    }


def parse_horizons(payload: dict) -> dict[float, Position]:
    """Position per epoch time (MJD to 1e-5 d); Horizons answers a failure in `error`."""
    if "error" in payload:
        raise ValueError(payload["error"])
    table = payload["result"].split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    positions = {}
    for line in table.strip().splitlines():
        jd, _, x, y, z = (cell.strip() for cell in line.split(",")[:5])
        positions[round(float(jd) - 2400000.5, 5)] = (float(x), float(y), float(z))
    return positions


def spherex_positions(mjds: list[float], cache_dir: Path) -> dict[float, Position]:
    """SPHEREx's positions, cached once JPL Horizons answered (the SBIdent cache keys contain
    them); an epoch time without one is looked up for the geocentre."""
    params = horizons_params(mjds)
    cached = cache_path(cache_dir, f"{HORIZONS_URL}?{urlencode(params)}")
    if cached.is_file():
        return {mjd: tuple(km) for mjd, km in json.loads(cached.read_text())}
    try:
        response = httpx.get(HORIZONS_URL, params=params, timeout=HORIZONS_TIMEOUT)
        response.raise_for_status()
        positions = parse_horizons(response.json())
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return {}
    _write(cached, json.dumps(list(positions.items())))
    return positions


def epoch_bodies(
    ra: float,
    dec: float,
    size_deg: float,
    mjd: float,
    cache_dir: Path,
    spherex: Position | None = None,
) -> SmallBodyEpoch:
    """One SBIdent query, cached on disk once it succeeded; a failure becomes the epoch's error."""
    params = query_params(ra, dec, size_deg, mjd, spherex)
    source_url = f"{SBIDENT_URL}?{urlencode(params)}"
    cached = cache_path(cache_dir, source_url)
    if cached.is_file():
        return SmallBodyEpoch.model_validate_json(cached.read_text())
    epoch = SmallBodyEpoch(
        mjd=mjd, date=Time(mjd, format="mjd").isot[:19] + "Z", source_url=source_url
    )
    try:
        response = httpx.get(SBIDENT_URL, params=params, timeout=TIMEOUT)
        response.raise_for_status()
        epoch.bodies = parse_sbident(response.json(), ra, dec, size_deg)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        epoch.error = (
            UNREACHABLE if status >= 500 else f"JPL SBIdent rejected the request (HTTP {status})"
        )
        return epoch
    except httpx.HTTPError:
        epoch.error = UNREACHABLE
        return epoch
    except (ValueError, KeyError, IndexError):
        epoch.error = "JPL SBIdent answered in an unexpected format"
        return epoch
    _write(cached, epoch.model_dump_json())
    return epoch


def find_small_bodies(ra: float, dec: float, size_deg: float, mjds: list[float]) -> dict:
    """Worker job: every epoch's known small bodies; epochs run in parallel, in time order."""
    cache_dir = get_settings().cache_dir
    report(0, len(mjds))
    positions = spherex_positions(mjds, cache_dir)
    with ThreadPoolExecutor(max_workers=PARALLEL_EPOCHS) as pool:
        futures = [
            pool.submit(epoch_bodies, ra, dec, size_deg, mjd, cache_dir, positions.get(mjd))
            for mjd in mjds
        ]
        for done, _ in enumerate(as_completed(futures), start=1):
            report(done, len(mjds))
    return {"epochs": [future.result().model_dump() for future in futures]}


def submit(
    redis: Redis, settings: Settings, ra: float, dec: float, size_deg: float, mjds: list[float]
) -> SmallBodiesJob:
    """Like jobs.submit_spectrum: a finished lookup is reused unless an epoch failed or had to
    fall back to the geocentre."""
    job_id = job_id_for(ra, dec, size_deg, mjds)
    current = status(redis, job_id)
    if current.status in ("queued", "started"):
        return current
    if current.status == "finished" and all(
        e.error is None and re.search(r"[?&]xobs=", e.source_url) for e in current.epochs
    ):
        return current
    queue = Queue(jobs.SLOW_QUEUE, connection=redis)
    if queue.count > settings.max_queued:
        raise jobs.QueueFull()
    with suppress(NoSuchJobError):
        Job.fetch(job_id, connection=redis).delete()
    queue.enqueue(
        find_small_bodies,
        kwargs={"ra": ra, "dec": dec, "size_deg": size_deg, "mjds": mjds},
        job_id=job_id,
        job_timeout=JOB_TIMEOUT_S,
        result_ttl=86400,
        failure_ttl=600,
    )
    return SmallBodiesJob(job_id=job_id, status="queued", total=len(mjds))


def status(redis: Redis, job_id: str) -> SmallBodiesJob:
    try:
        job = Job.fetch(job_id, connection=redis)
    except NoSuchJobError:
        return SmallBodiesJob(job_id=job_id, status="not_found")
    state = job.get_status()
    if state == JobStatus.FINISHED:
        result = job.return_value()
        if result is None:
            return SmallBodiesJob(job_id=job_id, status="not_found")
        epochs = [SmallBodyEpoch.model_validate(e) for e in result["epochs"]]
        done = len(epochs)
        return SmallBodiesJob(
            job_id=job_id, status="finished", progress=done, total=done, epochs=epochs
        )
    if state in (JobStatus.QUEUED, JobStatus.STARTED):
        running = "started" if state == JobStatus.STARTED else "queued"
        progress, total = int(job.meta.get("progress", 0)), int(job.meta.get("total", 0))
        return SmallBodiesJob(job_id=job_id, status=running, progress=progress, total=total)
    # Failed, stopped or cancelled (e.g. a worker restart): the next request starts it again.
    return SmallBodiesJob(
        job_id=job_id, status="failed", error=f"Small-body lookup {state.value} – start it again"
    )


@router.post("/api/smallbodies")
def create_small_bodies(request: SmallBodiesRequest, settings: SettingsDep) -> SmallBodiesJob:
    ra, dec = parse_ra(request.ra), parse_dec(request.dec)
    mjds = canonical_mjds(request.mjds)
    redis = jobs.connect(settings.redis_url)
    return submit(redis, settings, ra, dec, request.size_deg, mjds)


@router.get("/api/smallbodies/{job_id}")
def small_bodies_job(job_id: str, settings: SettingsDep) -> SmallBodiesJob:
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    return status(jobs.connect(settings.redis_url), job_id)
