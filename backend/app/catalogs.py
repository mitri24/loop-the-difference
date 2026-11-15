import csv
import io
import math
import os
import threading
from pathlib import Path

import httpx

from app.models import ProperMotion

GAIA_TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_TIMEOUT_S = 5.0
# Barnard's Star, the fastest star, moves ~166″ between J2000 and Gaia's epoch 2016.0.
SEARCH_RADIUS_DEG = 0.06
MATCH_ARCSEC = 2.0
# Galaxy cores get spurious proper motions in Gaia; a 5σ parallax shows the source is a star.
MIN_PARALLAX_OVER_ERROR = 5.0
J2000 = 2000.0
MJD_J2000 = 51544.5


def gaia_cache_path(cache_dir: Path, ra: float, dec: float) -> Path:
    # Six decimals, as the UI sends resolved positions (App.tsx toFixed(6)) and warm parses them.
    return cache_dir / "gaia" / f"pm_{ra:.6f}_{dec:.6f}.csv"


def find_proper_motion(
    ra: float, dec: float, strict: bool = False, cache_dir: Path | None = None
) -> ProperMotion | None:
    """Gaia DR3 star at a J2000 position; None when Gaia has none, or fails unless `strict`.

    With `cache_dir`, Gaia's raw answer (also an empty table) is kept on disk and used first, so a
    warmed target keeps its marker and spectrum position while Gaia is down. The match runs on
    every read, so a changed rule (e.g. MIN_PARALLAX_OVER_ERROR) applies to cached answers too.
    """
    cached = gaia_cache_path(cache_dir, ra, dec) if cache_dir else None
    if cached and cached.is_file():
        content = cached.read_text(errors="replace")
        if _is_gaia_table(content):
            return match_gaia_csv(content, ra, dec)
        cached.unlink(missing_ok=True)  # damaged: ask Gaia again
    query = (
        "SELECT source_id, ra, dec, pmra, pmdec, parallax, parallax_over_error, ref_epoch "
        "FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT(ra, dec), CIRCLE({ra}, {dec}, {SEARCH_RADIUS_DEG})) "
        "AND pmra IS NOT NULL"
    )
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}
    try:
        response = httpx.post(GAIA_TAP_URL, data=params, timeout=GAIA_TIMEOUT_S)
        response.raise_for_status()
    except httpx.HTTPError:
        if strict:
            raise
        return None
    if cached and _is_gaia_table(response.text):
        _write_text(cached, response.text)
    return match_gaia_csv(response.text, ra, dec)


def _is_gaia_table(content: str) -> bool:
    """A Gaia CSV answer starts with its header; an error page or an empty body does not."""
    return content.split("\n", 1)[0].strip().startswith("source_id,")


def _write_text(path: Path, content: str) -> None:
    """Atomic write: the API and both workers may store the same answer at once."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.part")
    partial.write_text(content)
    partial.replace(path)


def match_gaia_csv(content: str, ra: float, dec: float) -> ProperMotion | None:
    """Gaia positions are for 2016.0: move each star back to J2000 and take the closest one.

    The closest source counts only with a significant parallax, so a galaxy gets no marker.
    The player moves the star forward to each frame's date the same way (frontend/src/motion.ts).
    """
    best, best_sep, best_poe = None, MATCH_ARCSEC, None
    for row in csv.DictReader(io.StringIO(content)):
        try:
            star = ProperMotion(
                source_id=row["source_id"],
                ra=float(row["ra"]),
                dec=float(row["dec"]),
                ref_epoch=float(row["ref_epoch"]),
                pmra_mas_yr=float(row["pmra"]),
                pmdec_mas_yr=float(row["pmdec"]),
                parallax_mas=float(row["parallax"]) if row["parallax"] else None,
            )
            poe = float(row["parallax_over_error"]) if row["parallax_over_error"] else None
        except (KeyError, TypeError, ValueError):
            continue
        ra_j2000, dec_j2000 = position_at(star, MJD_J2000)
        d_ra = (ra_j2000 - ra + 180) % 360 - 180
        sep = 3600 * math.hypot(d_ra * math.cos(math.radians(dec)), dec_j2000 - dec)
        if sep < best_sep:
            best, best_sep, best_poe = star, sep, poe
    if best_poe is None or best_poe < MIN_PARALLAX_OVER_ERROR:
        return None
    return best


def position_at(star: ProperMotion, mjd: float) -> tuple[float, float]:
    """Gaia position moved to a visit's date, the same formula as the player (motion.ts)."""
    years = J2000 + (mjd - MJD_J2000) / 365.25 - star.ref_epoch
    dec = star.dec + star.pmdec_mas_yr * years / 3.6e6
    ra = star.ra + star.pmra_mas_yr * years / 3.6e6 / math.cos(math.radians(star.dec))
    return ra % 360, dec
