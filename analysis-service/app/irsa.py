"""Find SPHEREx observations covering a sky position with IRSA SIA2.

One SIA2 query per SPHEREx collection published by IRSA (``app.releases``), merged and
de-duplicated. Each row is one detector (band) of one exposure. For each row we
estimate, *before downloading anything*, where the target lands on the detector and
therefore which LVF wavelength it was observed at.
"""

from __future__ import annotations

import asyncio
import io
import logging
import warnings
from urllib.parse import urlencode

import httpx
import numpy as np
from astropy.io.votable import parse
from astropy.io.votable.exceptions import VOWarning

from .astrometry import mjd_to_iso
from .config import settings
from .footprint import fov_coverage, parse_s_region, sky_to_detector
from .releases import current_collections, get_state
from .schemas import Check, Observation, Visit
from .spectral import BANDS, load_wave_table

log = logging.getLogger(__name__)


def sia_url(collection: str, ra: float, dec: float, radius_deg: float) -> str:
    params = {
        "COLLECTION": collection,
        "POS": f"CIRCLE {ra:.7f} {dec:.7f} {radius_deg:.5f}",
        "RESPONSEFORMAT": "votable",
        "MAXREC": "20000",
    }
    return f"{settings.irsa_sia_url}?{urlencode(params)}"


def _rows_from_votable(content: bytes) -> tuple[list[dict], bool]:
    """Rows of the results table, and whether IRSA truncated it (QUERY_STATUS=OVERFLOW)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", VOWarning)
        vot = parse(io.BytesIO(content))
    table = None
    overflow = False
    for resource in vot.resources:
        if resource.type == "results":
            overflow = any(
                i.name == "QUERY_STATUS" and i.value == "OVERFLOW" for i in resource.infos
            )
            if resource.tables:
                table = resource.tables[0]
    if table is None:
        return [], overflow
    t = table.to_table(use_names_over_ids=True)
    rows = []
    for r in t:
        rows.append({k: (None if np.ma.is_masked(r[k]) else r[k]) for k in t.colnames})
    return rows, overflow


async def query_collection(
    client: httpx.AsyncClient, collection: str, ra: float, dec: float, radius_deg: float
) -> tuple[list[dict], bool]:
    """(rows, truncated) for one collection."""
    url = sia_url(collection, ra, dec, radius_deg)
    r = await client.get(url, timeout=settings.http_timeout_s)
    r.raise_for_status()
    rows, overflow = await asyncio.to_thread(_rows_from_votable, r.content)
    for row in rows:
        row["_collection"] = collection
    return rows, overflow


def _str(v: object) -> str:
    if isinstance(v, bytes):
        return v.decode()
    return "" if v is None else str(v)


def row_to_observation(row: dict, ra: float, dec: float, fov_deg: float) -> Observation | None:
    """Convert a SIA row; returns None if the target is not on the detector."""
    band_name = _str(row.get("energy_bandpassname")).replace("SPHEREx-", "")
    if band_name not in BANDS or _str(row.get("dataproduct_type")) != "image":
        return None
    quad = parse_s_region(_str(row.get("s_region")))
    if quad is None:
        return None
    x, y, inside = sky_to_detector(quad, ra, dec)
    if not inside:
        return None
    band = BANDS[band_name]
    lam = bw = None
    table = load_wave_table(band.detector)
    if table is not None:
        lam, bw = table(x, y)
    mjd = float(row["t_min"])
    return Observation(
        obs_publisher_did=_str(row.get("obs_publisher_did")),
        obs_id=_str(row.get("obs_id")),
        collection=_str(row.get("obs_collection")) or row["_collection"],
        band=band_name,
        detector=band.detector,
        mjd=mjd,
        date_utc=mjd_to_iso(mjd),
        exptime_s=float(row.get("t_exptime") or 0.0),
        access_url=_str(row.get("access_url")),
        s_region=_str(row.get("s_region")),
        em_min_um=float(row["em_min"]) * 1e6,
        em_max_um=float(row["em_max"]) * 1e6,
        resolving_power=float(row.get("em_res_power") or band.resolving_power),
        release_date=_str(row.get("obs_release_date")) or None,
        lambda_est_um=lam,
        bandwidth_est_um=bw,
        detector_xy_est=(x, y),
        fov_coverage=fov_coverage(quad, ra, dec, fov_deg),
    )


def assign_visits(observations: list[Observation], gap_days: float) -> list[Visit]:
    """Group observations into visits separated by more than ``gap_days``."""
    if not observations:
        return []
    order = sorted(observations, key=lambda o: o.mjd)
    visits: list[list[Observation]] = [[order[0]]]
    for o in order[1:]:
        if o.mjd - visits[-1][-1].mjd > gap_days:
            visits.append([o])
        else:
            visits[-1].append(o)
    out = []
    for i, group in enumerate(visits):
        for o in group:
            o.visit = i
        start, end = group[0].mjd, group[-1].mjd
        out.append(
            Visit(
                index=i,
                label=f"V{i + 1} {mjd_to_iso(start)[:7]}",
                mjd_start=start,
                mjd_end=end,
                n_observations=len(group),
            )
        )
    return out


async def find_observations(
    ra: float, dec: float, fov_deg: float, client: httpx.AsyncClient | None = None
) -> tuple[list[Observation], list[Visit], list[Check], list[str]]:
    """Query every SPHEREx collection IRSA currently publishes (app/releases.py) and
    return the observations sorted by time. New exposures and new releases show up
    automatically: nothing about the archive content is cached between searches."""
    radius = max(fov_deg / 2, 1 / 60)
    own = client is None
    client = client or httpx.AsyncClient(follow_redirects=True)
    checks: list[Check] = []
    try:
        collections = await current_collections(client)
        results = await asyncio.gather(
            *(query_collection(client, c, ra, dec, radius) for c in collections),
            return_exceptions=True,
        )
    finally:
        if own:
            await client.aclose()
    seen: dict[tuple[str, str], Observation] = {}
    # Physical identity of an exposure: detector + start time (1 s). Releases may rename
    # a reprocessed exposure (new obs_id); keeping both would stack it twice and
    # understate the noise. Verified disjoint today (QUALITY.md §3), guarded for later.
    seen_physical: set[tuple[str, int]] = set()
    dropped = 0
    for collection, res in zip(collections, results, strict=True):
        if isinstance(res, BaseException):
            checks.append(
                Check(
                    code="archive_error",
                    severity="warn",
                    title=f"IRSA query failed for {collection}",
                    detail=str(res)[:300],
                )
            )
            continue
        rows, overflow = res
        if overflow:
            checks.append(
                Check(
                    code="archive_overflow",
                    severity="warn",
                    title=f"{collection}: only the first {len(rows)} exposures returned",
                    detail="IRSA truncated the answer (very deep field). Use a smaller field "
                    "of view to get every exposure.",
                )
            )
        for row in rows:
            obs = row_to_observation(row, ra, dec, fov_deg)
            if obs is None:
                continue
            key = (obs.obs_id, obs.band)
            physical = (obs.band, round(obs.mjd * 86400))
            if key in seen or physical in seen_physical:
                dropped += 1  # first collection in preference order wins
                continue
            seen[key] = obs
            seen_physical.add(physical)
    observations = sorted(seen.values(), key=lambda o: (o.mjd, o.band))
    visits = assign_visits(observations, settings.visit_gap_days)
    if dropped:
        checks.append(
            Check(
                code="duplicates_dropped",
                severity="info",
                title=f"{dropped} duplicate exposure(s) ignored",
                detail="The same exposure was published in several releases; the preferred "
                "release (DR before QR, newest first) was kept.",
            )
        )
    checks.append(await _releases_check(client if not own else None))
    if any(o.lambda_est_um is None for o in observations):
        checks.append(
            Check(
                code="wave_table_missing",
                severity="info",
                title="Wavelength not estimated for some bands",
                detail="Run scripts/fetch_wcs_wave.py to store the LVF lookup tables; "
                "exact wavelengths are still computed after download.",
            )
        )
    urls = [sia_url(c, ra, dec, radius) for c in collections]
    return observations, visits, checks, urls


async def _releases_check(client: httpx.AsyncClient | None) -> Check:
    """Which SPHEREx releases were searched, and whether that list is current."""
    state = await get_state(client)
    names = ", ".join(state.collections)
    if state.error:
        return Check(
            code="releases",
            severity="warn",
            title="Release list may be out of date",
            detail=f"Could not re-check IRSA ({state.error}); searched {names}.",
        )
    if state.source.startswith("configuration"):
        return Check(
            code="releases",
            severity="info",
            title="Releases pinned by configuration",
            detail=f"Searched {names} (SPHEREX_COLLECTIONS); newer releases are ignored.",
        )
    return Check(
        code="releases",
        severity="ok",
        title=f"Searched every SPHEREx release at IRSA ({len(state.collections)})",
        detail=f"{names} — auto-discovered.",
    )


def search_checks(observations: list[Observation], visits: list[Visit]) -> list[Check]:
    """Rules.md §03: zero/one observation, no time baseline."""
    n = len(observations)
    if n == 0:
        return [
            Check(
                code="no_observations",
                severity="fail",
                title="No SPHEREx observation covers this position",
                detail="Nothing in the configured collections covers this position yet. "
                "SPHEREx data arrive weekly; try again later or another position.",
            )
        ]
    if n == 1:
        return [
            Check(
                code="single_observation",
                severity="fail",
                title="Cannot compare epochs",
                detail="Only one observation was found, so no change can be measured.",
            )
        ]
    if len(visits) < 2:
        return [
            Check(
                code="no_baseline",
                severity="warn",
                title="No usable time baseline",
                detail=f"All {n} observations come from a single visit "
                f"({visits[0].label}); motion over days only is not measurable for most "
                "sources. Blink within the visit shows wavelength changes, not motion.",
            )
        ]
    span_days = visits[-1].mjd_end - visits[0].mjd_start
    return [
        Check(
            code="baseline",
            severity="ok",
            title=f"{len(visits)} visits over {span_days / 365.25:.2f} years",
            detail=", ".join(f"{v.label} ({v.n_observations} images)" for v in visits),
        )
    ]
