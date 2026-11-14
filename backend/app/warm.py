"""Warm the cache for the demo targets, so the live demo does not depend on IRSA being responsive.

Run inside the worker image, where astropy and the cache volume exist:
    docker compose run --rm worker python -m app.warm [--dry-run] [--force] [--targets polaris]
--force also refreshes the cached search and name-resolution answers.
Every job writes the same manifest the UI would request, so a demo click is served from the cache.
"""

import argparse
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial

from app.archive import resolve_cache_path, resolve_position, sia_cache_path
from app.config import Settings, get_settings
from app.coords import parse_dec, parse_ra
from app.jobs import job_id_for
from app.models import FrameManifest
from app.tasks import build_frames, manifest_path

# Mirrors frontend/src/targets.ts (CHALLENGE_TARGETS): same strings, so demo clicks hit warmed keys.
TARGETS: list[tuple[str, str, str] | tuple[str, str]] = [
    ("Polaris", "02:31:49.09", "+89:15:50.8"),
    ("WISE 0855", "08h55m10.831s", "-7d14m42.53s"),
    ("Barnard's Star", "Barnard's Star"),
    ("Epsilon Indi B", "eps Ind B"),
    ("RW Aurigae", "RW Aur"),
    ("R Draconis", "R Dra"),
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


def run(
    argv: list[str] | None = None,
    settings: Settings | None = None,
    resolver: Resolver | None = None,
    build: Callable[..., dict] = build_frames,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the jobs, no network")
    parser.add_argument("--force", action="store_true", help="rebuild cached frames")
    parser.add_argument("--targets", help="comma-separated labels, e.g. polaris,wise0855")
    args = parser.parse_args(argv)
    settings = settings or get_settings()
    resolver = resolver or partial(resolve_position, settings=settings)
    only = {_slug(t) for t in args.targets.split(",")} if args.targets else None
    jobs = plan(only)
    if not jobs:
        print(f"No target matches {args.targets!r}; known: {', '.join(t[0] for t in TARGETS)}")
        return 2

    failed = 0
    resolved: dict[str, tuple[float, float]] = {}
    for job in jobs:
        if args.dry_run:
            key = job.key(settings.spherex_collection) or f"resolve:{job.name}"
            print(f"{key} · {job.target} · D{job.detector}")
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
            key = job.key(settings.spherex_collection)
            cached = manifest_path(settings.cache_dir, key)
            if args.force:
                sia_cache_path(
                    settings.cache_dir, settings.spherex_collection, job.ra, job.dec
                ).unlink(missing_ok=True)
            elif cached.is_file():
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


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


if __name__ == "__main__":
    sys.exit(run())
