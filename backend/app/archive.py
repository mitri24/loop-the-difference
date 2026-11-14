import hashlib
import io
import json
import os
import re
from collections import Counter
from pathlib import Path

import httpx
import numpy as np
from astropy.io.votable import parse
from astropy.time import Time

from app import names
from app.config import Settings
from app.models import Epoch, Observation, ObservationSummary

EPOCH_GAP_DAYS = 30.0
_DETECTOR = re.compile(r"D(\d)$")
_REQUIRED = ("obs_id", "energy_bandpassname", "em_min", "em_max", "t_min", "t_max", "access_url")


class ArchiveError(RuntimeError):
    pass


def search_observations(ra: float, dec: float, settings: Settings) -> list[Observation]:
    """Search IRSA once per position; the answer stays on disk so warmed targets need no network."""
    cached = sia_cache_path(settings.cache_dir, settings.spherex_collection, ra, dec)
    if cached.is_file():
        return parse_sia_votable(cached.read_bytes())
    params = {
        "COLLECTION": settings.spherex_collection,
        "POS": f"CIRCLE {ra} {dec} 0.0005",
        "MAXREC": "5000",
    }
    try:
        response = httpx.get(settings.irsa_sia_url, params=params, timeout=settings.http_timeout_s)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ArchiveError("SPHEREx archive (IRSA) is not reachable") from exc
    observations = parse_sia_votable(response.content)
    if observations:  # an empty answer may be a transient archive hiccup: ask again next time
        _write_cached(cached, response.content)
    return observations


def sia_cache_path(cache_dir: Path, collection: str, ra: float, dec: float) -> Path:
    # Same rounding as the frame job key, so a warmed position is hit by the UI request.
    return cache_dir / "sia" / f"{collection}_{ra:.5f}_{dec:.5f}.xml"


def resolve_position(name: str, settings: Settings) -> tuple[float, float]:
    """Target name → (ra, dec) in degrees via names.resolve, cached on disk for offline demos.

    Raises NameResolveError for unknown names and names.NameLookupTimeout on a slow Sesame.
    """
    cached = resolve_cache_path(settings.cache_dir, name)
    if cached.is_file():
        position = json.loads(cached.read_text())
        return position["ra"], position["dec"]
    ra, dec = names.resolve(name)
    ra, dec = float(ra), float(dec)
    _write_cached(cached, json.dumps({"name": name, "ra": ra, "dec": dec}).encode())
    return ra, dec


def resolve_cache_path(cache_dir: Path, name: str) -> Path:
    return cache_dir / "resolve" / f"{hashlib.sha256(name.encode()).hexdigest()[:16]}.json"


def _write_cached(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.{os.getpid()}.part")
    partial.write_bytes(content)
    partial.replace(path)


def parse_sia_votable(content: bytes) -> list[Observation]:
    votable = parse(io.BytesIO(content))
    results = next((r for r in votable.resources if r.type == "results"), None)
    if results is None or not results.tables:
        raise ArchiveError("Unexpected answer from the SPHEREx archive")
    observations = []
    for row in results.tables[0].to_table(use_names_over_ids=True):
        if str(row["dataproduct_subtype"]) != "science":
            continue
        if any(np.ma.is_masked(row[name]) for name in _REQUIRED):
            continue
        match = _DETECTOR.search(str(row["energy_bandpassname"]))
        if match is None:
            continue
        mjd = (float(row["t_min"]) + float(row["t_max"])) / 2
        observations.append(
            Observation(
                obs_id=str(row["obs_id"]),
                detector=int(match.group(1)),
                wavelength_min_um=float(row["em_min"]) * 1e6,
                wavelength_max_um=float(row["em_max"]) * 1e6,
                mjd=mjd,
                date=Time(mjd, format="mjd").isot[:19] + "Z",
                access_url=str(row["access_url"]),
            )
        )
    return sorted(observations, key=lambda o: o.mjd)


def group_epochs(observations: list[Observation]) -> list[list[Observation]]:
    """SPHEREx revisits a position in short windows, half a year apart: split on large gaps."""
    epochs: list[list[Observation]] = []
    for obs in sorted(observations, key=lambda o: o.mjd):
        if epochs and obs.mjd - epochs[-1][-1].mjd <= EPOCH_GAP_DAYS:
            epochs[-1].append(obs)
        else:
            epochs.append([obs])
    return epochs


def select_frames(observations: list[Observation], max_frames: int) -> list[Observation]:
    """Spread the frames over all epochs so the blink always shows the full time baseline."""
    epochs = group_epochs(observations)
    if not epochs:
        return []
    per_epoch = max(1, max_frames // len(epochs))
    picked = [obs for epoch in epochs for obs in _evenly(epoch, per_epoch)]
    return _evenly(picked, max_frames)


def summarize(
    ra: float, dec: float, collection: str, observations: list[Observation]
) -> ObservationSummary:
    detectors = Counter(o.detector for o in observations)
    return ObservationSummary(
        collection=collection,
        ra=ra,
        dec=dec,
        count=len(observations),
        detectors=dict(sorted(detectors.items())),
        epochs=[
            Epoch(start=epoch[0].date, end=epoch[-1].date, count=len(epoch))
            for epoch in group_epochs(observations)
        ],
        observations=observations,
    )


def _evenly(items: list[Observation], count: int) -> list[Observation]:
    if len(items) <= count:
        return list(items)
    indices = np.linspace(0, len(items) - 1, num=count).round().astype(int)
    return [items[i] for i in sorted(set(indices))]
