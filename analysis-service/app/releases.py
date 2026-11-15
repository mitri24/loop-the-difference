"""Automatic discovery of SPHEREx data releases and sky maps at IRSA.

NASA/IPAC publish new SPHEREx data continuously: new exposures are added to the
current collections every week, and new releases appear as new collections
(``spherex_qr4``, ``spherex_dr2``, …) or new HiPS maps. Nothing here is hard-coded:

* **Collections** — read from the IRSA SIA2 self-description (the ``COLLECTION``
  parameter options returned by any query), keeping SPHEREx *image* collections
  ``spherex_(dr|qr)<n>[_deep]``. Cubes (``spherex_dr1_cube``) are not single exposures and
  are skipped. Order = de-duplication preference: data releases (DR) before quick
  releases (QR), newest number first, all-sky survey before deep fields.
* **Sky maps** — read from IRSA's HiPS registry (``/data/hips/list``); every SPHEREx HiPS
  found is offered, newest first, the newest cube being the default background.

Results are cached for ``settings.release_refresh_s`` (default 6 h) and fall back to the
last known good answer (or a built-in default) if IRSA is unreachable. Setting
``SPHEREX_COLLECTIONS=spherex_dr1,spherex_qr3`` pins an explicit list instead of "auto".
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field

import httpx

from .config import settings

log = logging.getLogger(__name__)

COLLECTION_RE = re.compile(r"^spherex_(dr|qr)(\d+)(_deep)?$")
FALLBACK_COLLECTIONS = ["spherex_dr1", "spherex_qr3"]
FALLBACK_HIPS = {
    "id": "ivo://IPAC/P/SPHEREx/DR1/cube",
    "url": "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube",
    "label": "SPHEREx DR1 all-sky, 102 wavelengths (IRSA)",
    "cube": True,
    "release_date": None,
}
HIPS_LIST_URL = "https://irsa.ipac.caltech.edu/data/hips/list"
RETRY_AFTER_FAILURE_S = 300.0


@dataclass
class ReleaseState:
    collections: list[str] = field(default_factory=lambda: list(FALLBACK_COLLECTIONS))
    hips: list[dict] = field(default_factory=lambda: [dict(FALLBACK_HIPS)])
    checked_at: float = 0.0  # unix time of the last successful discovery
    source: str = "built-in default"  # "IRSA" once discovery succeeded, or "configuration"
    error: str | None = None


_STATE = ReleaseState()
_LOCK = asyncio.Lock()


def collection_sort_key(name: str) -> tuple[int, int, int, str]:
    m = COLLECTION_RE.match(name)
    if not m:
        return (9, 0, 0, name)
    kind, num, deep = m.groups()
    return (0 if kind == "dr" else 1, -int(num), 1 if deep else 0, name)


def select_collections(options: list[str], include_deep: bool) -> list[str]:
    """SPHEREx image collections among SIA2 COLLECTION options, in preference order."""
    chosen = [
        o for o in options if COLLECTION_RE.match(o) and (include_deep or not o.endswith("_deep"))
    ]
    return sorted(set(chosen), key=collection_sort_key)


def describe(name: str) -> dict:
    m = COLLECTION_RE.match(name)
    if not m:
        return {"name": name, "label": name, "kind": "other", "number": None, "deep": False}
    kind, num, deep = m.groups()
    label = f"{'Data Release' if kind == 'dr' else 'Quick Release'} {num}" + (
        " — deep fields" if deep else ""
    )
    return {"name": name, "label": label, "kind": kind, "number": int(num), "deep": bool(deep)}


def parse_hips_list(text: str) -> list[dict]:
    """SPHEREx entries of an IRSA HiPS registry listing (blank-line separated records)."""
    out = []
    for block in re.split(r"\n\s*\n", text):
        rec: dict[str, str] = {}
        for line in block.splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                rec.setdefault(k.strip(), v.strip())
        blob = f"{rec.get('creator_did', '')} {rec.get('obs_title', '')}"
        if "spherex" not in blob.lower() or "hips_service_url" not in rec:
            continue
        out.append(
            {
                "id": rec.get("creator_did") or rec["hips_service_url"],
                "url": rec["hips_service_url"].rstrip("/"),
                "label": f"{rec.get('obs_title', 'SPHEREx')} (IRSA)",
                "cube": rec.get("dataproduct_type") == "cube",
                "release_date": rec.get("hips_release_date"),
            }
        )
    # Newest first; cubes before flat maps at equal dates.
    out.sort(key=lambda h: (h["release_date"] or "", h["cube"]), reverse=True)
    return out


async def _discover(client: httpx.AsyncClient) -> tuple[list[str], list[dict]]:
    # Any SIA2 query returns the service self-description with the COLLECTION options.
    r = await client.get(
        settings.irsa_sia_url,
        params={"COLLECTION": FALLBACK_COLLECTIONS[0], "POS": "CIRCLE 0 0 0.0001", "MAXREC": "0"},
        timeout=60,
    )
    r.raise_for_status()
    options = re.findall(r'<OPTION value="([^"]+)"', r.text)
    collections = select_collections(options, settings.include_deep_fields)
    if not collections:
        raise RuntimeError("IRSA SIA2 lists no SPHEREx image collection")
    hips: list[dict] = []
    try:
        h = await client.get(HIPS_LIST_URL, timeout=60)
        h.raise_for_status()
        hips = parse_hips_list(h.text)
    except httpx.HTTPError as exc:
        log.warning("HiPS registry unavailable: %s", exc)
    return collections, hips


async def get_state(client: httpx.AsyncClient | None = None, force: bool = False) -> ReleaseState:
    """Current releases; re-discovered when older than ``settings.release_refresh_s``."""
    if settings.collections.strip().lower() != "auto":
        _STATE.collections = settings.collection_list
        _STATE.source = "configuration (SPHEREX_COLLECTIONS)"
        if _STATE.checked_at and not force:
            return _STATE
    fresh = time.time() - _STATE.checked_at < settings.release_refresh_s
    if fresh and not force:
        return _STATE
    async with _LOCK:
        if time.time() - _STATE.checked_at < settings.release_refresh_s and not force:
            return _STATE
        own = client is None
        client = client or httpx.AsyncClient(follow_redirects=True)
        try:
            collections, hips = await _discover(client)
            if settings.collections.strip().lower() == "auto":
                _STATE.collections = collections
                _STATE.source = "IRSA (auto-discovered)"
            if hips:
                _STATE.hips = hips
            _STATE.error = None
        except (httpx.HTTPError, RuntimeError) as exc:
            log.warning("release discovery failed, keeping %s: %s", _STATE.collections, exc)
            _STATE.error = f"{type(exc).__name__}: {exc}"[:200]
            # Retry in RETRY_AFTER_FAILURE_S rather than waiting a full refresh period.
            _STATE.checked_at = time.time() - settings.release_refresh_s + RETRY_AFTER_FAILURE_S
            return _STATE
        finally:
            if own:
                await client.aclose()
        _STATE.checked_at = time.time()
    return _STATE


async def current_collections(client: httpx.AsyncClient | None = None) -> list[str]:
    return list((await get_state(client)).collections)
