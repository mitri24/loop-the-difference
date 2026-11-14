"""Partner-agency data: NEOSSat (CSA) sky frames covering a position, counted at CADC.

A quick lookup like /api/resolve: the request waits at most LOOKUP_TIMEOUT_S, a late answer
still fills the disk cache for the next request. CADC answers most fields in 2–7 s, but fields
the archive has observed very often (R Dra lies in TESS's continuous viewing zone) take 15–50 s.
"""

import csv
import io
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as LookupTimeout
from pathlib import Path
from typing import Annotated
from urllib.parse import quote, urlencode

import httpx
from astropy.time import Time
from fastapi import APIRouter, Depends, HTTPException

from app.archive import ArchiveError, _write_cached
from app.config import Settings, get_settings
from app.coords import parse_dec, parse_ra
from app.models import NeossatCoverage

CADC_TAP_URL = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync"
CADC_SEARCH_URL = "https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/"
COLLECTION = "NEOSSAT"
LOOKUP_TIMEOUT_S = 10.0
CACHE_MAX_AGE_S = 86400.0
RADIUS_DEG = 0.001
NOTE = (
    "Visible-light frames from the Canadian Space Agency's NEOSSat, not comparable with "
    "SPHEREx infrared images. Dark calibration frames are not counted."
)

SettingsDep = Annotated[Settings, Depends(get_settings)]
router = APIRouter()

_lookups = ThreadPoolExecutor(max_workers=4, thread_name_prefix="cadc")
# One CADC query per position at a time: a retry waits for the query that is still running.
_pending: dict[Path, Future[NeossatCoverage]] = {}
_pending_lock = threading.Lock()


@router.get("/api/partners/neossat")
def neossat(ra: str, dec: str, settings: SettingsDep) -> NeossatCoverage:
    ra_deg, dec_deg = parse_ra(ra), parse_dec(dec)
    path = neossat_cache_path(settings.cache_dir, ra_deg, dec_deg)
    if path.is_file() and time.time() - path.stat().st_mtime < CACHE_MAX_AGE_S:
        return NeossatCoverage.model_validate_json(path.read_text())
    with _pending_lock:
        future = _pending.get(path)
        if future is None:
            future = _lookups.submit(_lookup, ra_deg, dec_deg, path, settings.http_timeout_s)
            _pending[path] = future
    try:
        return future.result(timeout=LOOKUP_TIMEOUT_S)
    except LookupTimeout:
        raise HTTPException(
            status_code=504, detail="NEOSSat archive (CADC) is slow – try again in a minute"
        ) from None


def neossat_cache_path(cache_dir: Path, ra: float, dec: float) -> Path:
    return cache_dir / "partners" / f"neossat_{ra:.5f}_{dec:.5f}.json"


def _lookup(ra: float, dec: float, path: Path, timeout_s: float) -> NeossatCoverage:
    try:
        coverage = fetch_neossat(ra, dec, timeout_s)
        _write_cached(path, coverage.model_dump_json().encode())
        return coverage
    finally:
        with _pending_lock:
            _pending.pop(path, None)


def fetch_neossat(ra: float, dec: float, timeout_s: float) -> NeossatCoverage:
    # Darks are pointed but show no sky; every NEOSSat frame has a raw and a processed plane.
    query = (
        "SELECT COUNT(DISTINCT o.obsID) AS n_obs, MIN(p.time_bounds_lower) AS t_min, "
        "MAX(p.time_bounds_upper) AS t_max "
        "FROM caom2.Plane AS p JOIN caom2.Observation AS o ON p.obsID = o.obsID "
        f"WHERE o.collection = '{COLLECTION}' AND o.type = 'object' "
        f"AND INTERSECTS(CIRCLE('ICRS', {ra}, {dec}, {RADIUS_DEG}), p.position_bounds) = 1"
    )
    params = {"LANG": "ADQL", "FORMAT": "csv", "QUERY": query}
    try:
        # The sync endpoint answers with a redirect to the job result.
        response = httpx.post(CADC_TAP_URL, data=params, timeout=timeout_s, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ArchiveError("NEOSSat archive (CADC) is not reachable") from exc
    return parse_neossat_csv(response.text, ra, dec)


def parse_neossat_csv(content: str, ra: float, dec: float) -> NeossatCoverage:
    try:
        row = next(csv.DictReader(io.StringIO(content)))
        count = int(row["n_obs"])
        first, last = _date(row["t_min"]), _date(row["t_max"])
    except (StopIteration, KeyError, TypeError, ValueError):
        raise ArchiveError("Unexpected answer from the NEOSSat archive (CADC)") from None
    return NeossatCoverage(
        collection=COLLECTION,
        ra=ra,
        dec=dec,
        count=count,
        first_date=first,
        last_date=last,
        search_url=search_url(ra, dec),
        note=NOTE,
    )


def search_url(ra: float, dec: float) -> str:
    params = {
        "Observation.collection": COLLECTION,
        "Observation.type": "object",
        "Plane.position.bounds": f"{ra:.5f} {dec:.5f}",
    }
    return f"{CADC_SEARCH_URL}?{urlencode(params, quote_via=quote)}#resultTableTab"


def _date(mjd: str) -> str | None:
    """CAOM time bounds are MJD (UTC); an empty value means no matching frame."""
    return Time(float(mjd), format="mjd").isot[:10] if mjd else None
