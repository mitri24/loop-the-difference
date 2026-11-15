"""Name resolution (CDS Sesame), reference catalogues (Gaia DR3, CatWISE2020, AllWISE), known
solar-system objects (JPL SBIdent) and other telescopes' images (CADC, Canada).

Catalogue positions are returned at their native epoch AND can be propagated to the
epoch of any SPHEREx frame with :func:`app.astrometry.propagate`. Known high-
proper-motion stars are the most common explanation of a blink "mover".
"""

from __future__ import annotations

import asyncio
import csv
import io
import math
import re
import warnings
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from urllib.parse import quote, urlencode

import httpx
import numpy as np
from astropy.io.votable.exceptions import VOWarning
from astropy.table import Table

from .astrometry import mjd_to_jyear
from .config import settings
from .schemas import (
    CadcCollection,
    CadcImage,
    CadcSearch,
    CatalogSource,
    Check,
    SolarSystemObject,
    Target,
)

GAIA_EPOCH = 2016.0
ALLWISE_EPOCH = 2010.5  # mean epoch of the AllWISE source positions


class ResolveError(LookupError):
    pass


def _float(text: str | None) -> float | None:
    try:
        return float(text) if text not in (None, "") else None
    except ValueError:
        return None


async def resolve_name(name: str, client: httpx.AsyncClient) -> Target:
    """Resolve an object name with CDS Sesame (SIMBAD first). Includes proper motion."""
    if not re.fullmatch(r"[\w\s+\-.'*()\[\]/:]{1,80}", name):
        raise ResolveError(f"Unsupported characters in name {name!r}.")
    r = await client.get(f"{settings.sesame_url}?{name}", timeout=30, follow_redirects=True)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    for resolver in root.iter("Resolver"):
        ra = _float(resolver.findtext("jradeg"))
        dec = _float(resolver.findtext("jdedeg"))
        if ra is None or dec is None:
            continue
        return Target(
            name=(resolver.findtext("oname") or name).replace("NAME ", "").strip(),
            ra=ra,
            dec=dec,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=_float(resolver.findtext(".//pmRA")),
            pm_dec_mas_yr=_float(resolver.findtext(".//pmDE")),
            source=f"CDS Sesame ({resolver.get('name', 'Simbad')})",
        )
    raise ResolveError(f"Sesame could not resolve {name!r}.")


def _cache_key(cat: str, ra: float, dec: float, radius: float) -> tuple:
    return (cat, round(ra, 4), round(dec, 4), round(radius, 4))


_CATALOG_CACHE: dict[tuple, list[CatalogSource]] = {}


async def gaia_cone(
    ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient, limit: int = 3000
) -> list[CatalogSource]:
    key = _cache_key("gaia", ra, dec, radius_deg)
    if key in _CATALOG_CACHE:
        return _CATALOG_CACHE[key]
    query = (
        f"SELECT TOP {limit} source_id, ra, dec, pmra, pmdec, phot_g_mean_mag "
        "FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
        f"CIRCLE('ICRS',{ra:.7f},{dec:.7f},{radius_deg:.5f})) ORDER BY phot_g_mean_mag"
    )
    r = await client.post(
        settings.gaia_tap_url,
        data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
        timeout=60,
    )
    r.raise_for_status()
    out = [
        CatalogSource(
            catalog="Gaia DR3",
            id=f"Gaia DR3 {row['source_id']}",
            ra=float(row["ra"]),
            dec=float(row["dec"]),
            mag=_float(row["phot_g_mean_mag"]),
            mag_band="G",
            pm_ra_mas_yr=_float(row["pmra"]),
            pm_dec_mas_yr=_float(row["pmdec"]),
            epoch_jyear=GAIA_EPOCH,
        )
        for row in csv.DictReader(io.StringIO(r.text))
    ]
    _CATALOG_CACHE[key] = out
    return out


_MOTION = ("pmra", "pmdec", "sigpmra", "sigpmdec")
# Nearest rows per catalogue and field, as in backend/app/sources.py.
IRSA_MAX_ROWS = 10000


async def _irsa_cone(
    table: str, columns: str, ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient
) -> list[dict[str, str]]:
    """Rows of an IRSA catalogue table around (ra, dec), nearest first, from IRSA Gator as a
    VOTable; values as text, empty when null. Gator reports a failure as a VOTable without a
    table (or an HTML page): ValueError."""
    r = await client.get(
        settings.irsa_gator_url,
        params={
            "catalog": table,
            "spatial": "cone",
            "objstr": f"{ra:.7f} {dec:.7f}",
            "radius": f"{radius_deg * 3600:.2f}",
            "radunits": "arcsec",
            "outfmt": 3,
            "selcols": columns,
            "outrows": IRSA_MAX_ROWS,
        },
        timeout=60,
    )
    r.raise_for_status()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", VOWarning)
            rows = Table.read(io.BytesIO(r.content), format="votable")
    except VOWarning as exc:
        raise ValueError(f"IRSA Gator answered no {table} table") from exc
    return [
        {name: "" if np.ma.is_masked(row[name]) else str(row[name]) for name in rows.colnames}
        for row in rows
    ]


def _significant(
    pmra: float | None, pmdec: float | None, sig_ra: float | None, sig_dec: float | None
) -> tuple[float, float] | tuple[None, None]:
    """The motion when a component exceeds 3σ, else none: WISE motions are noisy, and
    propagating noise over a decade or more would move sources by many arcseconds."""
    if pmra is None or pmdec is None:
        return None, None
    if abs(pmra) < 3 * (sig_ra or 0.0) and abs(pmdec) < 3 * (sig_dec or 0.0):
        return None, None
    return pmra, pmdec


async def allwise_cone(
    ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient
) -> list[CatalogSource]:
    key = _cache_key("allwise", ra, dec, radius_deg)
    if key in _CATALOG_CACHE:
        return _CATALOG_CACHE[key]
    out = []
    columns = "designation,ra,dec,w1mpro,pmra,pmdec,sigpmra,sigpmdec"
    for row in await _irsa_cone("allwise_p3as_psd", columns, ra, dec, radius_deg, client):
        pmra, pmdec = _significant(*(_float(row.get(column)) for column in _MOTION))
        out.append(
            CatalogSource(
                catalog="AllWISE",
                id=f"AllWISE {row['designation']}",
                ra=float(row["ra"]),
                dec=float(row["dec"]),
                mag=_float(row.get("w1mpro")),
                mag_band="W1",
                pm_ra_mas_yr=pmra,
                pm_dec_mas_yr=pmdec,
                epoch_jyear=ALLWISE_EPOCH,
            )
        )
    _CATALOG_CACHE[key] = out
    return out


async def catwise_cone(
    ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient
) -> list[CatalogSource]:
    """CatWISE2020 (WISE/NEOWISE 2010–2018): motions ~12× more accurate than AllWISE's.

    Its default ra/dec are the stationary fit (not ra_pm/dec_pm at MJD 57170). They lie
    at each source's mean observation epoch: the CatWISE fragments of WISE 0855−0714 (8″/yr
    west) lie the further west, the later their meanobsmjd. pmra is µα·cos δ like Gaia's, in
    arcsec/yr: G 252-33 at Dec +73° has −0.96 (Gaia −0.91; dα/dt would be −3.1). The tile
    offsets (≲40 mas/yr) stay below 1″ by 2026. A missing column raises: wise_cone falls back."""
    key = _cache_key("catwise", ra, dec, radius_deg)
    if key in _CATALOG_CACHE:
        return _CATALOG_CACHE[key]
    out = []
    columns = "source_name,ra,dec,w1mpro,meanobsmjd,pmra,pmdec,sigpmra,sigpmdec"
    for row in await _irsa_cone("catwise_2020", columns, ra, dec, radius_deg, client):
        pmra, pmdec = _significant(*(_float(row[column]) for column in _MOTION))
        out.append(
            CatalogSource(
                catalog="CatWISE2020",
                id=f"CatWISE2020 {row['source_name']}",
                ra=float(row["ra"]),
                dec=float(row["dec"]),
                mag=_float(row["w1mpro"]),
                mag_band="W1",
                pm_ra_mas_yr=None if pmra is None else pmra * 1000,
                pm_dec_mas_yr=None if pmdec is None else pmdec * 1000,
                epoch_jyear=mjd_to_jyear(float(row["meanobsmjd"])),
            )
        )
    _CATALOG_CACHE[key] = out
    return out


async def wise_cone(
    ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient
) -> tuple[list[CatalogSource], list[Check]]:
    """CatWISE2020, else AllWISE with a warning; raises when IRSA delivers neither."""
    try:
        return await catwise_cone(ra, dec, radius_deg, client), []
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        reason = type(exc).__name__
    return await allwise_cone(ra, dec, radius_deg, client), [
        Check(
            code="catwise_unavailable",
            severity="warn",
            title="CatWISE2020 unavailable – AllWISE used",
            detail=f"IRSA did not deliver CatWISE2020 ({reason}). Red sources are matched "
            "against AllWISE: positions from 2010 and motions only above 3σ, so a fast "
            "brown dwarf can lie outside the match radius or go unrecognised as moving.",
        )
    ]


# ---------------------------------------------------------------- solar-system objects
SBIDENT_URL = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
SBIDENT_TIMEOUT_S = 300.0  # measured ~150 s for a 0.4° field (QUALITY.md §3)
# SBIdent looks from SPHEREx when JPL Horizons gives its position, as in backend/app/smallbodies.py
# (horizons_params and parse_horizons are the same code there, backend/tests/test_smallbodies.py).
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
# "SPHEREx (spacecraft)" in JPL Horizons; its ephemeris starts at launch (2025-03-12).
SPHEREX_HORIZONS_ID = "-163182"
HORIZONS_TIMEOUT_S = 60.0
# Geocentric ICRF position in km.
Position = tuple[float, float, float]


def _sexa_ra(deg: float) -> str:
    h = (deg % 360) / 15
    hh, rem = int(h), (h - int(h)) * 60
    mm, ss = int(rem), (rem - int(rem)) * 60
    return f"{hh:02d}-{mm:02d}-{ss:05.2f}"


def _sexa_dec(deg: float) -> str:
    sign = "+" if deg >= 0 else "-"
    d = abs(deg)
    dd, rem = int(d), (d - int(d)) * 60
    mm, ss = int(rem), (rem - int(rem)) * 60
    return f"{sign}{dd:02d}-{mm:02d}-{ss:04.1f}"


def _parse_ra_hms(text: str) -> float:
    h, m, s = (float(v) for v in text.split(":"))
    return 15 * (h + m / 60 + s / 3600)


def _parse_dec_dms(text: str) -> float:
    t = text.replace("'", " ").replace('"', " ").split()
    sign = -1 if t[0].startswith("-") else 1
    d, m, s = abs(float(t[0])), float(t[1]), float(t[2])
    return sign * (d + m / 60 + s / 3600)


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


async def spherex_position(mjd: float, client: httpx.AsyncClient) -> Position | None:
    """SPHEREx's geocentric position at one time, kept once JPL Horizons answered; None
    without an answer (before launch, Horizons down)."""
    when = round(mjd, 5)
    if when in _SPHEREX_AT:
        return _SPHEREX_AT[when]
    try:
        r = await client.get(
            HORIZONS_URL, params=horizons_params([mjd]), timeout=HORIZONS_TIMEOUT_S
        )
        r.raise_for_status()
        position = parse_horizons(r.json()).get(when)
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None
    if position is not None:
        _SPHEREX_AT[when] = position
    return position


_SPHEREX_AT: dict[float, Position] = {}


async def sbident_field(
    ra: float, dec: float, half_width_deg: float, mjd: float, client: httpx.AsyncClient
) -> list[SolarSystemObject]:
    """Known asteroids and comets in a square field at one instant (JPL SBIdent).

    Observer = SPHEREx at that instant (JPL Horizons), passed as `xobs` with zero velocity,
    so the rates stay geocentric. Without its position the geocentre (MPC code 500): SPHEREx
    is in low-Earth orbit, ~7,000 km from it, which shifts main-belt objects by up to ~10"
    and near-Earth objects by arcminutes."""
    from astropy.time import Time

    spherex = await spherex_position(mjd, client)
    observer = "SPHEREx" if spherex else "geocentre"
    key = _cache_key(f"sb{mjd:.4f}{observer}", ra, dec, half_width_deg)
    if key in _SB_CACHE:
        return _SB_CACHE[key]
    when = Time(mjd, format="mjd", scale="utc").strftime("%Y-%m-%d_%H:%M:%S")
    where = (
        {"xobs": ",".join(f"{km:.3f}" for km in spherex) + ",0,0,0"}
        if spherex
        else {"mpc-code": "500"}
    )
    r = await client.get(
        SBIDENT_URL,
        params={
            **where,
            "obs-time": when,
            "fov-ra-center": _sexa_ra(ra),
            "fov-dec-center": _sexa_dec(dec),
            "fov-ra-hwidth": f"{half_width_deg:.4f}",
            "fov-dec-hwidth": f"{half_width_deg:.4f}",
            "two-pass": "true",
            "suppress-first-pass": "true",
        },
        timeout=SBIDENT_TIMEOUT_S,
    )
    r.raise_for_status()
    body = r.json()
    fields = body.get("fields_second", [])
    out: list[SolarSystemObject] = []
    for row in body.get("data_second_pass", []):
        d = dict(zip(fields, row, strict=False))
        out.append(
            SolarSystemObject(
                name=str(d.get("Object name", "?")).strip(),
                ra=_parse_ra_hms(d["Astrometric RA (hh:mm:ss)"]),
                dec=_parse_dec_dms(d["Astrometric Dec (dd mm'ss\")"]),
                vmag=_float(d.get("Visual magnitude (V)")),
                ra_rate_arcsec_h=_float(d.get('RA rate ("/h)')) or 0.0,
                dec_rate_arcsec_h=_float(d.get('Dec rate ("/h)')) or 0.0,
                mjd=mjd,
                observer=observer,
            )
        )
    _SB_CACHE[key] = out
    return out


_SB_CACHE: dict[tuple, list[SolarSystemObject]] = {}


# ------------------------------------------------------------ other telescopes (CADC)
# The Canadian Astronomy Data Centre (NRC Canada) indexes images from many telescopes in
# one CAOM-2 database, including the Canadian Space Agency's NEOSSat. We list what exists
# at the target position as *context* (other wavelengths and epochs); these images are
# never mixed with SPHEREx in the blink or the difference.

CADC_MAX_ROWS = 3000
CADC_IMAGES_PER_COLLECTION = 8
# TESS full-frame-image cutouts outnumber everything else by 10-1000x (508 764 rows within
# 3' of R Dra) and make the query take minutes: left out, and said so in the UI.
CADC_EXCLUDED = ("TESS",)
# Spectrograph fibres and slits are stored as "image" planes too (CFHT SPIRou: 1.8"
# footprint, 1073 planes at Barnard's Star; HST STIS spectroscopy: < 7"). They are not
# pictures of the sky: keep planes whose footprint is at least 18" across.
CADC_MIN_FOOTPRINT_DEG = 0.005
# Below 0.5"/yr even a 40-year-old image is offset by < 20" (< 1/10 of the default 4'
# search radius): no proper-motion note needed.
CADC_PM_NOTE_ARCSEC_YR = 0.5
CADC_LABELS = {
    "NEOSSAT": ("NEOSSat — Canadian Space Agency microsatellite (optical)", True),
    "CFHT": ("Canada-France-Hawaii Telescope", True),
    "CFHTMEGAPIPE": ("CFHT MegaPipe stacked images", True),
    "CFHTTERAPIX": ("CFHT Terapix stacked images", True),
    "DAO": ("Dominion Astrophysical Observatory (NRC Canada)", True),
    "OMM": ("Observatoire du Mont-Mégantic (Canada)", True),
    "JCMT": ("James Clerk Maxwell Telescope (submillimetre)", True),
    "GEMINI": ("Gemini Observatory (Canada is a partner)", True),
    "HST": ("Hubble Space Telescope", False),
    "HSTHLA": ("Hubble Legacy Archive", False),
    "JWST": ("James Webb Space Telescope", False),
    "SDSS": ("Sloan Digital Sky Survey", False),
    "APASS": ("AAVSO Photometric All-Sky Survey", False),
    "SUBARU": ("Subaru Telescope", False),
    "SUBARUCADC": ("Subaru Telescope (CADC processing)", False),
    "VLASS": ("VLA Sky Survey (radio)", False),
    "RACS": ("ASKAP RACS survey (radio)", False),
    "IRIS": ("IRAS reprocessed (IRIS, far-infrared)", False),
    "XMM": ("XMM-Newton (X-ray)", False),
}
_CADC_CACHE: dict[tuple, CadcSearch] = {}


def _cadc_where(ra: float, dec: float, radius_deg: float) -> str:
    """Public-or-not science image planes whose footprint overlaps the search circle.

    Calibration/acquisition frames (o.intent = 'calibration': 59 of 630 NEOSSat planes at
    Barnard's Star) and spectrograph fibres/slits (footprint < 18") are left out."""
    excluded = ", ".join(f"'{c}'" for c in CADC_EXCLUDED)
    return (
        f"WHERE INTERSECTS(CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.5f}), "
        "p.position_bounds) = 1 AND p.dataProductType = 'image' AND o.intent = 'science' "
        f"AND p.calibrationLevel >= 1 AND p.position_bounds_size >= {CADC_MIN_FOOTPRINT_DEG} "
        f"AND o.collection NOT IN ({excluded})"
    )


_CADC_FROM = "FROM caom2.Plane AS p JOIN caom2.Observation AS o ON p.obsID = o.obsID "


def cadc_query(ra: float, dec: float, radius_deg: float) -> str:
    """Listing (one row per plane and thumbnail). TOP without ORDER BY: an arbitrary subset
    when truncated (ORDER BY made the query time out), hence the separate counts query."""
    return (
        f"SELECT TOP {CADC_MAX_ROWS} o.collection, o.observationID, o.instrument_name, "
        "o.target_name, p.publisherID, p.time_bounds_lower, p.time_exposure, "
        "p.energy_bandpassName, p.calibrationLevel, p.dataRelease, a.uri "
        + _CADC_FROM
        + "LEFT OUTER JOIN caom2.Artifact AS a "
        "ON (a.planeID = p.planeID AND a.productType = 'thumbnail') "
        + _cadc_where(ra, dec, radius_deg)
    )


def cadc_counts_query(ra: float, dec: float, radius_deg: float) -> str:
    """Exact number of image planes and date range per collection (~2 s at Barnard)."""
    return (
        "SELECT o.collection, COUNT(*) AS n, MIN(p.time_bounds_lower) AS t0, "
        "MAX(p.time_bounds_lower) AS t1 "
        + _CADC_FROM
        + _cadc_where(ra, dec, radius_deg)
        + " GROUP BY o.collection"
    )


def cadc_file_url(uri: str | None) -> str | None:
    """Public URL of a CAOM artifact URI (cadc:… via the CADC locator, mast:… via MAST)."""
    if not uri:
        return None
    if uri.startswith("cadc:"):
        return f"{settings.cadc_files_url}/{uri}"
    if uri.startswith("mast:"):
        return f"https://mast.stsci.edu/api/v0.1/Download/file?uri={quote(uri, safe=':/')}"
    return None


def _valid_mjd(mjd: float | None) -> float | None:
    return mjd if mjd is not None and math.isfinite(mjd) and mjd > 0 else None


def _mjd_iso(mjd: float | None) -> str | None:
    if _valid_mjd(mjd) is None:
        return None
    from .astrometry import mjd_to_iso

    return mjd_to_iso(mjd)


def _is_embargoed(release: str | None, now: datetime) -> bool:
    """CAOM: a null dataRelease means *not public* (verified: such a CFHT plane answers 403
    for its preview and FITS). Unparseable dates are treated the same way (fail closed)."""
    if not release:
        return True
    try:
        when = datetime.fromisoformat(release)
    except ValueError:
        return True
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when > now


def parse_cadc_rows(text: str, now: datetime | None = None) -> tuple[list[CadcImage], int]:
    """CSV rows → (one image per plane, number of CSV rows). Several thumbnails of one
    plane are de-duplicated; the row count is what TOP limits."""
    now = now or datetime.now(UTC)
    seen: dict[str, CadcImage] = {}
    n_rows = 0
    for row in csv.DictReader(io.StringIO(text)):
        n_rows += 1
        pid = row["publisherID"]
        thumb = cadc_file_url(row.get("uri"))
        if pid in seen:
            if thumb and not seen[pid].thumbnail_url and not seen[pid].proprietary:
                seen[pid].thumbnail_url = thumb
            continue
        proprietary = _is_embargoed(row.get("dataRelease"), now)
        mjd = _valid_mjd(_float(row.get("time_bounds_lower")))
        level = _float(row.get("calibrationLevel"))
        seen[pid] = CadcImage(
            collection=row["collection"],
            observation_id=row["observationID"],
            instrument=row.get("instrument_name") or None,
            target_name=row.get("target_name") or None,
            band=row.get("energy_bandpassName") or None,
            mjd=mjd,
            date_utc=_mjd_iso(mjd),
            exptime_s=_float(row.get("time_exposure")),
            calibration_level=int(level) if level is not None and math.isfinite(level) else None,
            thumbnail_url=None if proprietary else thumb,
            files_url=f"{settings.cadc_datalink_url}?{urlencode({'ID': pid})}",
            proprietary=proprietary,
        )
    return list(seen.values()), n_rows


def parse_cadc_counts(text: str) -> dict[str, tuple[int, float | None, float | None]]:
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        n = _float(row.get("n"))
        out[row["collection"]] = (
            int(n) if n is not None else 0,
            _valid_mjd(_float(row.get("t0"))),
            _valid_mjd(_float(row.get("t1"))),
        )
    return out


def group_cadc(
    images: list[CadcImage],
    counts: dict[str, tuple[int, float | None, float | None]] | None = None,
) -> list[CadcCollection]:
    """One entry per collection. Counts and date ranges come from the exact GROUP BY query
    when available (the listing can be truncated), else from the listed images."""
    by: dict[str, list[CadcImage]] = {}
    for im in images:
        by.setdefault(im.collection, []).append(im)
    counts = counts or {}
    out = []
    for coll in sorted(set(by) | set(counts)):
        ims = by.get(coll, [])
        if coll in counts:
            n, t0, t1 = counts[coll]
        else:
            mjds = [i.mjd for i in ims if i.mjd is not None]
            n, t0, t1 = len(ims), min(mjds, default=None), max(mjds, default=None)
        label, canadian = CADC_LABELS.get(coll, (coll, False))
        band_n: dict[str, int] = {}
        for i in ims:
            if i.band:
                band_n[i.band] = band_n.get(i.band, 0) + 1
        bands = sorted(band_n, key=lambda b: (-band_n[b], b))
        shown = sorted(ims, key=lambda i: (i.thumbnail_url is None, -(i.mjd or 0)))[
            :CADC_IMAGES_PER_COLLECTION
        ]
        out.append(
            CadcCollection(
                collection=coll,
                label=label,
                canadian=canadian,
                n_images=max(n, len(ims)),
                first_date=_mjd_iso(t0),
                last_date=_mjd_iso(t1),
                bands=bands[:8],
                instruments=sorted({i.instrument for i in ims if i.instrument})[:4],
                images=shown,
            )
        )
    # The Canadian Space Agency's NEOSSat first, then Canadian facilities, then by size.
    out.sort(key=lambda c: (c.collection != "NEOSSAT", not c.canadian, -c.n_images))
    return out


def cadc_motion_check(
    pm_arcsec_yr: float, centre_jyear: float, collections: list[CadcCollection]
) -> Check | None:
    """The search circle is centred on the target *today*: say how far it sat from that
    centre in the oldest listed images (they may be off-centre, or missed)."""
    if pm_arcsec_yr <= CADC_PM_NOTE_ARCSEC_YR:
        return None
    dated = [(c.first_date, c.collection) for c in collections if c.first_date]
    detail = f"The search circle is centred on its {centre_jyear:.1f} position."
    if dated:
        first, coll = min(dated)
        year = int(first[:4])
        offset = pm_arcsec_yr * max(0.0, centre_jyear - year) / 60
        detail += (
            f" In the oldest image listed here ({year}, {coll}) it sat {offset:.1f}′ away, "
            "so old images may show it off-centre, and some that contained it then may be "
            "missing from this list."
        )
    return Check(
        code="cadc_proper_motion",
        severity="info",
        title=f"Target moves {pm_arcsec_yr:.1f}″/yr",
        detail=detail,
    )


async def cadc_images(
    ra: float, dec: float, radius_deg: float, client: httpx.AsyncClient
) -> CadcSearch:
    """Images from other telescopes whose footprint overlaps the field, from the CADC
    (CAOM-2 TAP): exact counts per collection + a listing with previews.

    Tolerant: an unavailable service returns an empty result with a warning check."""
    key = _cache_key("cadc", ra, dec, radius_deg)
    if key in _CADC_CACHE:
        return _CADC_CACHE[key]

    def params(q: str) -> dict[str, str]:
        return {"LANG": "ADQL", "FORMAT": "csv", "QUERY": q}

    listing = params(cadc_query(ra, dec, radius_deg))
    query_url = f"{settings.cadc_tap_url}?{urlencode(listing)}"
    search_url = (
        f"{settings.cadc_search_ui_url}?"
        + urlencode(
            {
                "Plane.position.bounds@Shape1Resolver.value": "ALL",
                "Plane.position.bounds": f"{ra:.5f} {dec:.5f}",
            }
        )
        + "#resultTableTab"
    )
    checks: list[Check] = []
    try:
        r_list, r_count = await asyncio.gather(
            client.get(settings.cadc_tap_url, params=listing, timeout=120),
            client.get(
                settings.cadc_tap_url,
                params=params(cadc_counts_query(ra, dec, radius_deg)),
                timeout=120,
            ),
        )
        r_list.raise_for_status()
        r_count.raise_for_status()
        images, n_rows = parse_cadc_rows(r_list.text)
        counts = parse_cadc_counts(r_count.text)
    except (httpx.HTTPError, KeyError, csv.Error) as exc:
        return CadcSearch(
            ra=ra,
            dec=dec,
            radius_arcmin=radius_deg * 60,
            n_images=0,
            collections=[],
            truncated=False,
            excluded_collections=list(CADC_EXCLUDED),
            query_url=query_url,
            search_url=search_url,
            checks=[
                Check(
                    code="cadc_unavailable",
                    severity="warn",
                    title="CADC archive unavailable",
                    detail=f"The Canadian Astronomy Data Centre did not answer "
                    f"({type(exc).__name__}). SPHEREx results are not affected.",
                )
            ],
        )
    truncated = n_rows >= CADC_MAX_ROWS
    if truncated:
        checks.append(
            Check(
                code="cadc_truncated",
                severity="info",
                title="Previews from part of the list only",
                detail=f"Counts and dates are complete, but previews come from the first "
                f"{CADC_MAX_ROWS} archive rows returned. Open the CADC search for every image.",
            )
        )
    collections = group_cadc(images, counts)
    result = CadcSearch(
        ra=ra,
        dec=dec,
        radius_arcmin=radius_deg * 60,
        n_images=sum(c.n_images for c in collections),
        collections=collections,
        truncated=truncated,
        excluded_collections=list(CADC_EXCLUDED),
        query_url=query_url,
        search_url=search_url,
        checks=checks,
    )
    _CADC_CACHE[key] = result
    return result
