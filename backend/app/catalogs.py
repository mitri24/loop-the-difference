import csv
import io
import math

import httpx

from app.models import ProperMotion

GAIA_TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_TIMEOUT_S = 5.0
# Barnard's Star, the fastest star, moves ~166″ between J2000 and Gaia's epoch 2016.0.
SEARCH_RADIUS_DEG = 0.06
MATCH_ARCSEC = 2.0
J2000 = 2000.0


def find_proper_motion(ra: float, dec: float) -> ProperMotion | None:
    """Gaia DR3 star at the J2000 position of a resolved name; None when Gaia has none or fails."""
    query = (
        "SELECT source_id, ra, dec, pmra, pmdec, parallax, ref_epoch FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT(ra, dec), CIRCLE({ra}, {dec}, {SEARCH_RADIUS_DEG})) "
        "AND pmra IS NOT NULL"
    )
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}
    try:
        response = httpx.post(GAIA_TAP_URL, data=params, timeout=GAIA_TIMEOUT_S)
        response.raise_for_status()
    except httpx.HTTPError:
        return None
    return match_gaia_csv(response.text, ra, dec)


def match_gaia_csv(content: str, ra: float, dec: float) -> ProperMotion | None:
    """Gaia positions are for 2016.0: move each star back to J2000 and take the closest one.

    The player moves the star forward to each frame's date the same way (frontend/src/motion.ts).
    """
    best, best_sep = None, MATCH_ARCSEC
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
        except (KeyError, TypeError, ValueError):
            continue
        years = J2000 - star.ref_epoch
        dec_j2000 = star.dec + star.pmdec_mas_yr * years / 3.6e6
        ra_j2000 = star.ra + star.pmra_mas_yr * years / 3.6e6 / math.cos(math.radians(star.dec))
        d_ra = (ra_j2000 - ra + 180) % 360 - 180
        sep = 3600 * math.hypot(d_ra * math.cos(math.radians(dec)), dec_j2000 - dec)
        if sep < best_sep:
            best, best_sep = star, sep
    return best
