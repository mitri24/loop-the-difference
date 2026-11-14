"""Surprise me: a random fast-moving nearby star from Gaia DR3, so its motion shows in the blink."""

import csv
import io
import json
import os
import random
import threading
import time
from pathlib import Path

import httpx

from app import warm
from app.archive import resolve_cache_path
from app.catalogs import GAIA_TAP_URL, MJD_J2000, position_at
from app.config import Settings
from app.coords import parse_dec, parse_ra
from app.models import ProperMotion, SurpriseTarget

# 200 of the 362 matching stars: Gaia stops scanning there after ~23 s; all of them take 50–65 s.
QUERY = (
    "SELECT TOP 200 source_id, ra, dec, pmra, pmdec, pm, parallax, ref_epoch, phot_g_mean_mag "
    "FROM gaiadr3.gaia_source WHERE pm > 1000 AND phot_g_mean_mag BETWEEN 8 AND 14"
)
GAIA_TIMEOUT_S = 40.0
CACHE_MAX_AGE_S = 24 * 3600
RETRY_AFTER_S = 600
GAIA_DOWN = "Gaia is not reachable – showing an example instead"


def pick(settings: Settings, rng: random.Random | None = None) -> SurpriseTarget:
    rng = rng or random.Random()
    stars = candidates(settings)
    if stars:
        return rng.choice(stars)
    return rng.choice(examples(settings))


def cache_path(settings: Settings) -> Path:
    return settings.cache_dir / "surprise" / "gaia_fast_stars.csv"


def candidates(settings: Settings, force: bool = False) -> list[SurpriseTarget]:
    """The star list, cached on disk for 24 h; an older list beats none when Gaia is down."""
    path = cache_path(settings)
    stars = parse_gaia_csv(path.read_text()) if path.is_file() else []
    if stars and not force and _age_s(path) < CACHE_MAX_AGE_S:
        return stars
    # A failed query takes up to 40 s: wait a while before the next click asks Gaia again.
    tried = path.with_name("gaia_last_try")
    if not force and tried.is_file() and _age_s(tried) < RETRY_AFTER_S:
        return stars
    path.parent.mkdir(parents=True, exist_ok=True)
    tried.touch()
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": QUERY}
    try:
        response = httpx.post(GAIA_TAP_URL, data=params, timeout=GAIA_TIMEOUT_S)
        response.raise_for_status()
    except httpx.HTTPError:
        return stars
    fresh = parse_gaia_csv(response.text)
    if not fresh:
        return stars
    partial = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.part")
    partial.write_text(response.text)
    partial.replace(path)
    return fresh


def _age_s(path: Path) -> float:
    return time.time() - path.stat().st_mtime


def parse_gaia_csv(content: str) -> list[SurpriseTarget]:
    stars = []
    for row in csv.DictReader(io.StringIO(content)):
        try:
            motion = ProperMotion(
                source_id=row["source_id"],
                ra=float(row["ra"]),
                dec=float(row["dec"]),
                ref_epoch=float(row["ref_epoch"]),
                pmra_mas_yr=float(row["pmra"]),
                pmdec_mas_yr=float(row["pmdec"]),
                parallax_mas=float(row["parallax"]) if row["parallax"] else None,
            )
            pm, g_mag = float(row["pm"]), float(row["phot_g_mean_mag"])
        except (KeyError, TypeError, ValueError):
            continue
        # The J2000 position, like a resolved name: the player moves it to each frame's date.
        ra, dec = position_at(motion, MJD_J2000)
        stars.append(
            SurpriseTarget(
                name=f"Gaia DR3 {motion.source_id}",
                ra=ra,
                dec=dec,
                proper_motion=motion,
                pm_mas_yr=pm,
                g_mag=g_mag,
                reason=(
                    f"A fast-moving nearby star: it moves {pm / 1000:.1f}″ per year "
                    "– watch it shift between the visits"
                ),
            )
        )
    return stars


def examples(settings: Settings) -> list[SurpriseTarget]:
    """Example targets whose position is known without the network: given, or resolved before."""
    found = []
    for label, *where in warm.TARGETS:
        if len(where) == 2:
            ra, dec = parse_ra(where[0]), parse_dec(where[1])
        else:
            cached = resolve_cache_path(settings.cache_dir, where[0])
            if not cached.is_file():
                continue
            answer = json.loads(cached.read_text())
            ra, dec = answer["ra"], answer["dec"]
        found.append(SurpriseTarget(name=label, ra=ra, dec=dec, reason=GAIA_DOWN))
    return found
