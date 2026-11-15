"""Warm the cache for the demo targets, so the live demo does not depend on IRSA being responsive.

Run inside the worker image, where astropy and the cache volume exist:
    docker compose run --rm worker python -m app.warm [--dry-run] [--force] [--targets polaris]
--force also refreshes the cached search and name-resolution answers.
Every job writes the same manifest the UI would request, so a demo click is served from the cache.
Each target's spectrum is built once too (--no-spectrum skips it): that downloads its cutouts, so
the spectrum click only measures them. The spectrum itself lives in the RQ job, not on disk.
"""

import argparse
import re
import shutil
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from pydantic import ValidationError

from app.archive import (
    collection_key,
    collections_cache_path,
    resolve_cache_path,
    resolve_position,
    sia_cache_path,
    spherex_collections,
)
from app.catalogs import gaia_cache_path
from app.config import Settings, get_settings
from app.coords import parse_dec, parse_ra
from app.jobs import job_id_for
from app.models import FrameManifest
from app.tasks import PIPELINE_VERSION, build_frames, build_spectrum, manifest_path

# Mirrors frontend/src/targets.ts (CHALLENGE_TARGETS): same strings, so demo clicks hit warmed keys.
TARGETS: list[tuple[str, str, str] | tuple[str, str]] = [
    ("Polaris", "02:31:49.09", "+89:15:50.8"),
    ("WISE 0855", "08h55m10.831s", "-7d14m42.53s"),
    ("Barnard's Star", "Barnard's Star"),
    ("Epsilon Indi B", "eps Ind B"),
    ("RW Aurigae", "RW Aur"),
    ("R Draconis", "R Dra"),
    ("Pluto · known dwarf planet (2026)", "308.5364", "-22.9153"),
]
# D6 plus one short-wavelength detector; view defaults from frontend/src/url.ts and App.tsx.
DETECTORS = (6, 1)
SIZE_DEG = 0.2
MAX_FRAMES = 12

Resolver = Callable[[str], tuple[float, float]]


@dataclass(frozen=True)
class WarmJob:
    target: str
    detector: int
    ra: float | None = None
    dec: float | None = None
    name: str | None = None

    def key(self, collection: str) -> str | None:
        if self.ra is None or self.dec is None:
            return None
        return job_id_for(collection, self.ra, self.dec, SIZE_DEG, self.detector, MAX_FRAMES)


def plan(only: set[str] | None = None) -> list[WarmJob]:
    jobs = []
    for target in TARGETS:
        label = target[0]
        if only and _slug(label) not in only:
            continue
        for detector in DETECTORS:
            if len(target) == 3:
                ra, dec = parse_ra(target[1]), parse_dec(target[2])
                jobs.append(WarmJob(label, detector, ra=ra, dec=dec))
            else:
                jobs.append(WarmJob(label, detector, name=target[1]))
    return jobs


def prune_stale_frames(cache_dir: Path) -> list[str]:
    """Delete frame folders built by an older pipeline version: their job ids are never requested.

    Folders without a manifest are left alone: a worker may be writing them right now.
    Cutouts live elsewhere and stay, they belong to the archive URL, not to the version.
    """
    removed = []
    frames_dir = cache_dir / "frames"
    for folder in list(frames_dir.iterdir()) if frames_dir.is_dir() else ():
        manifest = manifest_path(cache_dir, folder.name)
        if not manifest.is_file():
            continue
        try:
            version = FrameManifest.model_validate_json(manifest.read_text()).pipeline_version
        except ValidationError as exc:  # one unreadable folder must not stop the warm run
            print(f"SKIPPED · frames/{folder.name} · unreadable manifest: {exc}", file=sys.stderr)
            continue
        if version != PIPELINE_VERSION:
            shutil.rmtree(folder)
            removed.append(folder.name)
    return removed


def run(
    argv: list[str] | None = None,
    settings: Settings | None = None,
    resolver: Resolver | None = None,
    build: Callable[..., dict] = build_frames,
    spectrum: Callable[..., dict] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the jobs, no downloads")
    parser.add_argument("--force", action="store_true", help="rebuild cached frames")
    parser.add_argument("--targets", help="comma-separated labels, e.g. polaris,wise0855")
    parser.add_argument("--no-spectrum", action="store_true", help="warm the frames only")
    args = parser.parse_args(argv)
    settings = settings or get_settings()
    resolver = resolver or partial(resolve_position, settings=settings)
    spectrum = spectrum or build_spectrum
    only = {_slug(t) for t in args.targets.split(",")} if args.targets else None
    jobs = plan(only)
    if not jobs:
        print(f"No target matches {args.targets!r}; known: {', '.join(t[0] for t in TARGETS)}")
        return 2

    if not args.dry_run:
        stale = prune_stale_frames(settings.cache_dir)
        if stale:
            print(f"removed {len(stale)} frame folders from older pipeline versions")

    if args.force and not args.dry_run:
        collections_cache_path(settings.cache_dir).unlink(missing_ok=True)
    collections = spherex_collections(settings)
    collection = collection_key(collections)
    failed = 0
    resolved: dict[str, tuple[float, float]] = {}
    spectra: set[str] = set()
    for job in jobs:
        if args.dry_run:
            key = job.key(collection) or f"resolve:{job.name}"
            print(f"{key} · {job.target} · D{job.detector}")
            if not args.no_spectrum and job.target not in spectra:
                spectra.add(job.target)
                print(f"spectrum · {job.target}")
            continue
        started = time.monotonic()
        try:
            if job.name is not None:
                if job.name not in resolved:
                    if args.force:
                        resolve_cache_path(settings.cache_dir, job.name).unlink(missing_ok=True)
                    resolved[job.name] = resolver(job.name)
                ra, dec = resolved[job.name]
                # The UI sends the resolved degrees with six decimals (App.tsx toFixed(6)).
                job = WarmJob(
                    job.target, job.detector, parse_ra(f"{ra:.6f}"), parse_dec(f"{dec:.6f}")
                )
            key = job.key(collection)
            cached = manifest_path(settings.cache_dir, key)
            if args.force:
                for name in collections:
                    sia_cache_path(settings.cache_dir, name, job.ra, job.dec).unlink(
                        missing_ok=True
                    )
            if not args.no_spectrum and job.target not in spectra:
                spectra.add(job.target)
                if args.force:  # refreshed by this target's one spectrum job, not per detector
                    gaia_cache_path(settings.cache_dir, job.ra, job.dec).unlink(missing_ok=True)
                failed += not _warm_spectrum(partial(spectrum, collections=collections), job)
            if not args.force and cached.is_file():
                manifest = FrameManifest.model_validate_json(cached.read_text())
                if manifest.complete:
                    print(f"{key} · {job.target} · D{job.detector} · cached")
                    continue
            result = build(
                key=key,
                ra=job.ra,
                dec=job.dec,
                size_deg=SIZE_DEG,
                detector=job.detector,
                max_frames=MAX_FRAMES,
                collections=collections,
            )
        except Exception as exc:  # one failed target must not stop the others
            failed += 1
            print(f"FAILED · {job.target} · D{job.detector} · {exc}", file=sys.stderr)
            continue
        seconds = time.monotonic() - started
        state = "" if result["complete"] else " · INCOMPLETE (re-run to retry)"
        failed += not result["complete"]
        print(
            f"{key} · {job.target} · D{job.detector} · {len(result['frames'])} frames · "
            f"{seconds:.1f} s · {len(result['warnings'])} warnings{state}"
        )
    return 1 if failed else 0


def _warm_spectrum(spectrum: Callable[..., dict], job: WarmJob) -> bool:
    """Build the target's spectrum once, at the position the UI sends; a failure stays local."""
    started = time.monotonic()
    try:
        result = spectrum(job.ra, job.dec)
    except Exception as exc:  # the frames of this target are still worth warming
        print(f"FAILED · spectrum · {job.target} · {exc}", file=sys.stderr)
        return False
    skipped = [c["detail"] for c in result["checks"] if c["code"] == "SPECTRUM_POINTS_SKIPPED"]
    state = "" if result["complete"] else " · INCOMPLETE (re-run to retry)"
    print(
        f"spectrum · {job.target} · {len(result['points'])} points · "
        f"{time.monotonic() - started:.1f} s{''.join(f' · {s}' for s in skipped)}{state}"
    )
    return result["complete"]


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


if __name__ == "__main__":
    sys.exit(run())
