"""Time and proper-motion helpers.

High-proper-motion targets matter here: Barnard's Star moves 10.4"/yr, so its J2000
catalogue position is ~4.5' away from where SPHEREx saw it in 2025-2026. Every
position we centre on or overlay is propagated to the epoch of the data.
"""

from __future__ import annotations

import math

from astropy.time import Time


def mjd_to_jyear(mjd: float) -> float:
    return float(Time(mjd, format="mjd").jyear)


def jyear_to_mjd(jyear: float) -> float:
    return float(Time(jyear, format="jyear").mjd)


def mjd_to_iso(mjd: float) -> str:
    return str(Time(mjd, format="mjd", scale="utc").isot)[:19] + "Z"


def propagate(
    ra: float,
    dec: float,
    pm_ra_mas_yr: float | None,
    pm_dec_mas_yr: float | None,
    from_jyear: float,
    to_jyear: float,
) -> tuple[float, float]:
    """Linear proper-motion propagation (pmRA includes cos δ). Good to <0.1" over decades
    for the targets of interest; parallax and radial velocity are ignored."""
    if not pm_ra_mas_yr and not pm_dec_mas_yr:
        return ra, dec
    dt = to_jyear - from_jyear
    cosd = max(math.cos(math.radians(dec)), 1e-9)
    dra = (pm_ra_mas_yr or 0.0) * dt / 3.6e6 / cosd
    ddec = (pm_dec_mas_yr or 0.0) * dt / 3.6e6
    new_dec = max(-90.0, min(90.0, dec + ddec))
    return (ra + dra) % 360.0, new_dec


def angular_sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    s = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(s)))) * 3600
