import hashlib
import io
import json
import math
import os
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree

import httpx
import numpy as np
from astropy.io.votable import parse
from astropy.time import Time

from app import names
from app.config import Settings
from app.models import Epoch, Observation, ObservationSummary

EPOCH_GAP_DAYS = 30.0
STACK_PER_EPOCH = 8
_DETECTOR = re.compile(r"D(\d)$")
# SPHEREx Level-2 image collections (DR1, QR3, their deep fields); not the `_cube` HiPS.
_SPHEREX_COLLECTION = re.compile(r"^spherex_(dr|qr)\d+(_deep)?$")
COLLECTIONS_MAX_AGE_S = 86400
COLLECTIONS_RETRY_S = 3600
COLLECTIONS_TIMEOUT_S = 15.0
# IRSA's search answers 502/503 under load or in an outage: ask twice more, then say so.
SEARCH_ATTEMPTS = 3
SEARCH_RETRY_S = 1.5
_SEARCH_RETRY_STATUS = {429, 500, 502, 503, 504}
# IRSA needs ~22 s per search whatever is asked; the API and the worker ask for the same position
# at once. A marker next to the cache file lets the second asker wait for the first one's answer.
SEARCH_POLL_S = 0.5
SEARCH_INFLIGHT_GRACE_S = 10.0
# One refresh of the stale collection list per process at a time, in the background.
_refresh_lock = threading.Lock()
_REQUIRED = ("obs_id", "energy_bandpassname", "em_min", "em_max", "t_min", "t_max", "access_url")


class ArchiveError(RuntimeError):
    pass


def search_observations(
    ra: float, dec: float, settings: Settings, collections: list[str] | None = None
) -> tuple[list[Observation], list[str]]:
    """Search every SPHEREx collection at once: the merged observations and the collections whose
    search failed. Only when every collection fails is the archive unreachable."""
    collections = collections or spherex_collections(settings)
    with ThreadPoolExecutor(max_workers=len(collections)) as pool:
        futures = [pool.submit(_search_collection, ra, dec, c, settings) for c in collections]
    found: list[Observation] = []
    empty: list[tuple[Path, bytes]] = []
    failed: list[str] = []
    errors: list[ArchiveError] = []
    for collection, future in zip(collections, futures, strict=True):
        try:
            observations, uncached = future.result()
        except ArchiveError as exc:
            failed.append(collection)
            errors.append(exc)
            continue
        found += observations
        if uncached is not None:
            empty.append((sia_cache_path(settings.cache_dir, collection, ra, dec), uncached))
    if errors and len(errors) == len(collections):
        raise errors[0]
    if found:  # another release has data here: an empty answer is real, not a hiccup
        for path, content in empty:
            _write_cached(path, content)
    return sorted(found, key=lambda o: o.mjd), failed


def _search_collection(
    ra: float, dec: float, collection: str, settings: Settings
) -> tuple[list[Observation], bytes | None]:
    """Search IRSA once per position; the answer stays on disk so warmed targets need no network.

    An empty answer is not cached here but returned, the caller decides.
    """
    cached = sia_cache_path(settings.cache_dir, collection, ra, dec)
    if cached.is_file():
        return parse_sia_votable(cached.read_bytes(), collection), None
    marker = cached.with_suffix(".inflight")
    inflight_s = settings.http_timeout_s + SEARCH_INFLIGHT_GRACE_S
    if _await_search(cached, marker, inflight_s):
        return parse_sia_votable(cached.read_bytes(), collection), None
    # Nobody else is asking (or the other search ended without an answer): ask IRSA once.
    _write_cached(marker, str(os.getpid()).encode())
    try:
        params = {"COLLECTION": collection, "POS": f"CIRCLE {ra} {dec} 0.0005", "MAXREC": "5000"}
        response = _search(settings, params)
        observations = parse_sia_votable(response.content, collection)
        if not observations:
            return [], response.content
        _write_cached(cached, response.content)
        return observations, None
    finally:
        marker.unlink(missing_ok=True)


def _await_search(cached: Path, marker: Path, inflight_s: float) -> bool:
    """Another process asks IRSA for this position: wait for its answer instead of asking again.

    True when the cached answer appeared. False when nobody is asking, the marker is older than
    `inflight_s` (a crashed searcher) or vanished without an answer (empty or failed search).
    """
    while True:
        if cached.is_file():
            return True
        try:
            age = time.time() - marker.stat().st_mtime
        except FileNotFoundError:
            return cached.is_file()  # the answer lands before the marker goes
        if age >= inflight_s:
            return False
        time.sleep(SEARCH_POLL_S)


def _search(settings: Settings, params: dict[str, str]) -> httpx.Response:
    """One SIA2 query, asked again on a busy or failing gateway; the error names IRSA's answer."""
    for attempt in range(1, SEARCH_ATTEMPTS + 1):
        try:
            # IRSA's GET gateway can return 502 while the same SIA query works as POST.
            # Switch transport after the first transient failure, keeping the query unchanged.
            response = (
                httpx.get(settings.irsa_sia_url, params=params, timeout=settings.http_timeout_s)
                if attempt == 1
                else httpx.post(settings.irsa_sia_url, data=params, timeout=settings.http_timeout_s)
            )
            response.raise_for_status()
            return response
        except httpx.HTTPError as exc:
            retry = (
                exc.response.status_code in _SEARCH_RETRY_STATUS
                if isinstance(exc, httpx.HTTPStatusError)
                else isinstance(exc, httpx.TransportError)
            )
            if attempt < SEARCH_ATTEMPTS and retry:
                if attempt > 1:
                    time.sleep(SEARCH_RETRY_S * attempt)
                continue
            raise ArchiveError(unreachable_text(exc)) from exc
    raise AssertionError("unreachable")


def unreachable_text(exc: httpx.HTTPError) -> str:
    """What the user reads when IRSA's search fails: its own answer, and what still works."""
    if isinstance(exc, httpx.HTTPStatusError):
        answer = f"its search answered HTTP {exc.response.status_code} {exc.response.reason_phrase}"
    elif isinstance(exc, httpx.TimeoutException):
        answer = "its search did not answer in time"
    else:
        answer = "the connection failed"
    return (
        f"SPHEREx archive (IRSA) is not reachable: {answer}. "
        "Previously saved comparisons remain available; a new position needs the archive. "
        "Try again later."
    )


def spherex_collections(settings: Settings) -> list[str]:
    """Every SPHEREx Level-2 image collection IRSA lists, kept on disk for a day.

    A known list is answered at once, whatever its age; an old one is refreshed in the background
    (IRSA's self-description took minutes today). Only a fresh install waits for IRSA. IRSA silent:
    the last known list, else the collections with stored answers (warmed targets keep working in
    every release they were found in), else the configured collection alone.
    """
    cached = collections_cache_path(settings.cache_dir)
    if cached.is_file():
        if time.time() - cached.stat().st_mtime >= COLLECTIONS_MAX_AGE_S:
            _refresh_collections_in_background(settings)
        return json.loads(cached.read_text())
    found = _fetch_collections_or_nothing(settings)
    if found:
        _write_cached(cached, json.dumps(found).encode())
        return found
    # The releases with stored answers, else the configured one; kept like an old list, so IRSA
    # is asked again in an hour, not by every request (its self-description took minutes today).
    fallback = cached_collections(settings.cache_dir) or [settings.spherex_collection]
    _write_cached(cached, json.dumps(fallback).encode())
    _postpone_refresh(cached)
    return fallback


def _refresh_collections_in_background(settings: Settings) -> None:
    """Refresh the stale list in a daemon thread, one per process at a time."""
    if not _refresh_lock.acquire(blocking=False):
        return  # a refresh is already running

    def refresh() -> None:
        cached = collections_cache_path(settings.cache_dir)
        try:
            found = _fetch_collections_or_nothing(settings)
            if found:
                _write_cached(cached, json.dumps(found).encode())
            elif cached.is_file():
                _postpone_refresh(cached)  # IRSA is silent: keep the old list for an hour
        finally:
            _refresh_lock.release()

    try:
        _start_thread(refresh)
    except RuntimeError:  # no thread could be started: the next request tries again
        _refresh_lock.release()
        raise


def _start_thread(target) -> None:
    # Daemon: a slow IRSA must not keep a process alive. Tests swap this to run inline.
    threading.Thread(target=target, daemon=True).start()


def _postpone_refresh(cached: Path) -> None:
    retry_at = time.time() - COLLECTIONS_MAX_AGE_S + COLLECTIONS_RETRY_S
    os.utime(cached, (retry_at, retry_at))


def _fetch_collections_or_nothing(settings: Settings) -> list[str]:
    try:
        return _fetch_collections(settings)
    except (httpx.HTTPError, ElementTree.ParseError):
        return []


def _fetch_collections(settings: Settings) -> list[str]:
    try:
        response = httpx.get(
            settings.irsa_sia_url, params={"MAXREC": "0"}, timeout=COLLECTIONS_TIMEOUT_S
        )
        response.raise_for_status()
    except httpx.HTTPError:
        response = httpx.post(
            settings.irsa_sia_url, data={"MAXREC": "0"}, timeout=COLLECTIONS_TIMEOUT_S
        )
        response.raise_for_status()
    return parse_collections(response.content)


def parse_collections(content: bytes) -> list[str]:
    """The SPHEREx image collections among the COLLECTION options of the SIA2 self-description."""
    options = (
        option.get("value", "")
        for param in ElementTree.fromstring(content).iter()
        if param.tag.endswith("PARAM") and param.get("name") == "COLLECTION"
        for option in param.iter()
        if option.tag.endswith("OPTION")
    )
    return sorted({value for value in options if _SPHEREX_COLLECTION.match(value)})


def cached_collections(cache_dir: Path) -> list[str]:
    """The SPHEREx collections with stored SIA answers ({collection}_{ra}_{dec}.xml), sorted."""
    names = {path.stem.rsplit("_", 2)[0] for path in (cache_dir / "sia").glob("spherex_*.xml")}
    return sorted(name for name in names if _SPHEREX_COLLECTION.match(name))


def collections_cache_path(cache_dir: Path) -> Path:
    return cache_dir / "collections.json"


def collection_key(collections: list[str]) -> str:
    """The collection set as it enters job keys and the manifest's `collection` field."""
    return ",".join(sorted(collections))


def release_label(collection: str) -> str:
    """spherex_dr1 → "DR1", spherex_qr3_deep → "QR3 deep"; anything else stays as it is."""
    match = _SPHEREX_COLLECTION.match(collection)
    if match is None:
        return collection
    name = collection.removeprefix("spherex_").removesuffix("_deep").upper()
    return f"{name} deep" if match.group(2) else name


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


def parse_sia_votable(content: bytes, collection: str | None = None) -> list[Observation]:
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
        start, end = float(row["t_min"]), float(row["t_max"])
        mjd = (start + end) / 2
        observations.append(
            Observation(
                obs_id=str(row["obs_id"]),
                detector=int(match.group(1)),
                wavelength_min_um=float(row["em_min"]) * 1e6,
                wavelength_max_um=float(row["em_max"]) * 1e6,
                mjd=mjd,
                date=Time(mjd, format="mjd").isot[:19] + "Z",
                access_url=str(row["access_url"]),
                cloud_url=parse_cloud_access(row.get("cloud_access")),
                collection=collection,
                s_region=_cell(row, "s_region", str),
                # In ObsCore units, as IRSA's FIELDs state them: t_exptime in s, t_min and t_max
                # in MJD, s_resolution and s_pixel_scale in arcsec; em_res_power is λ/Δλ.
                exposure_s=_cell(row, "t_exptime", float),
                start_mjd=start,
                end_mjd=end,
                spatial_resolution_arcsec=_cell(row, "s_resolution", float),
                resolving_power=_cell(row, "em_res_power", float),
                calib_level=_cell(row, "calib_level", int),
                publisher_did=_cell(row, "obs_publisher_did", str),
                instrument_name=_cell(row, "instrument_name", str),
                facility_name=_cell(row, "facility_name", str),
                release_date=_timestamp(_cell(row, "obs_release_date", str)),
                pixel_scale_arcsec=_cell(row, "s_pixel_scale", float),
            )
        )
    return sorted(observations, key=lambda o: o.mjd)


def _cell(row, name: str, kind: type) -> float | int | str | None:
    """One cell as `kind`; None when the answer lacks the column or leaves the cell empty."""
    value = row.get(name)
    if value is None or np.ma.is_masked(value) or not str(value).strip():
        return None
    try:
        value = kind(value)
    except (TypeError, ValueError):
        return None
    return None if isinstance(value, float) and not math.isfinite(value) else value


def _timestamp(value: str | None) -> str | None:
    """A DALI timestamp (UTC; IRSA writes "2026-09-27 23:59:28") in the form of Observation.date."""
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}Z"


def parse_cloud_access(value: object) -> str | None:
    """IRSA's `cloud_access` JSON → the same file on AWS S3 as an anonymous HTTPS URL."""
    try:
        aws = json.loads(str(value))["aws"]
        return f"https://{aws['bucket_name']}.s3.amazonaws.com/{aws['key']}"
    except (ValueError, KeyError, TypeError):  # missing column, masked or empty value
        return None


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


def select_for_stacks(
    observations: list[Observation], per_epoch: int = STACK_PER_EPOCH
) -> list[Observation]:
    """Up to `per_epoch` exposures per epoch, evenly spread: each epoch stacks into one frame."""
    return [obs for epoch in group_epochs(observations) for obs in _evenly(epoch, per_epoch)]


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
