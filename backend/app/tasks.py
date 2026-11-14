import warnings
from concurrent.futures import ThreadPoolExecutor
from itertools import combinations
from pathlib import Path

import httpx
import numpy as np
from rq import get_current_job

from app.archive import group_epochs, search_observations, select_for_stacks, select_frames
from app.config import get_settings
from app.frames import (
    R_BY_DETECTOR,
    SPHEREX_PIXEL_SCALE_ARCSEC,
    align,
    comparable_wavelengths,
    cutout_url,
    delta_lambda_pct,
    fetch_cutout,
    read_image,
    render_diff,
    render_png,
    target_grid,
    wavelength_at,
)
from app.models import Check, Difference, Frame, FrameManifest, Observation

MIN_COVERAGE = 0.5
# Bump whenever the rendered output changes: the job key changes, so cached results are rebuilt,
# and `warm` removes frame folders whose manifest carries an older version.
PIPELINE_VERSION = 5


def manifest_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / "frames" / key / "manifest.json"


def epoch_checks(usable: int, epochs: int) -> list[Check]:
    """Can the usable observations be compared across epochs at all?"""
    if usable < 2:
        return [
            Check(
                code="NO_OBSERVATIONS" if usable == 0 else "SINGLE_EPOCH",
                severity="error" if usable == 0 else "blocker",
                message="Not enough usable observations to compare epochs",
                detail="Cannot compare epochs: fewer than two usable observations",
                affects=["difference"],
            )
        ]
    if epochs < 2:
        return [
            Check(
                code="NO_TIME_BASELINE",
                severity="blocker",
                message="All usable observations come from one epoch",
                detail="No usable time baseline: all usable observations come from one epoch",
                affects=["difference"],
            )
        ]
    return []


def wavelength_checks(wavelengths: list[float | None], detector: int) -> list[Check]:
    """Were all frames of the blink observed through the same part of the filter?"""
    known = [w for w in wavelengths if w is not None]
    if len(known) < 2 or comparable_wavelengths(min(known), max(known), detector):
        return []
    return [
        Check(
            code="WAVELENGTH_MISMATCH",
            severity="blocker",
            message="Frames were observed at different wavelengths",
            detail=f"Effective wavelength ranges from {min(known):.3f} to {max(known):.3f} µm "
            f"({delta_lambda_pct(min(known), max(known)):.1f} %, more than one resolution element "
            f"1/R = {100 / R_BY_DETECTOR[detector]:.1f} % of detector {detector}); "
            "a direct difference needs wavelength-matched frames",
            affects=["difference"],
        )
    ]


def build_frames(
    key: str,
    ra: float,
    dec: float,
    size_deg: float,
    detector: int,
    max_frames: int,
    stack: bool = False,
) -> dict:
    """Worker job: find the observations, cut them out, align them and render the blink frames."""
    settings = get_settings()
    observations = [o for o in search_observations(ra, dec, settings) if o.detector == detector]
    selected = select_for_stacks(observations) if stack else select_frames(observations, max_frames)
    urls = [cutout_url(o.access_url, ra, dec, size_deg) for o in selected]
    _report(0, len(selected))

    checks: list[Check] = []
    downloaded = []
    with (
        httpx.Client(timeout=settings.http_timeout_s, follow_redirects=True) as client,
        ThreadPoolExecutor(max_workers=settings.download_workers) as pool,
    ):
        futures = [
            pool.submit(fetch_cutout, client, url, settings.cache_dir / "cutouts") for url in urls
        ]
        for done, (obs, url, future) in enumerate(
            zip(selected, urls, futures, strict=True), start=1
        ):
            try:
                downloaded.append((obs, url, future.result()))
            except httpx.HTTPError:
                checks.append(
                    Check(
                        code="CUTOUT_MISSING",
                        severity="warning",
                        message="Archive did not deliver a cutout",
                        detail=f"{obs.obs_id}: archive did not deliver the cutout, frame skipped "
                        "(requesting the same view again retries it)",
                        affects=[f"obs:{obs.obs_id}"],
                    )
                )
            _report(done, len(selected))

    target, shape = target_grid(ra, dec, size_deg)
    kept, images = [], []
    for obs, url, path in downloaded:
        data, wcs = read_image(path)
        image, coverage = align(data, wcs, target, shape)
        if coverage < MIN_COVERAGE:
            checks.append(
                Check(
                    code="LOW_OVERLAP",
                    severity="warning",
                    message="Observation covers too little of the field",
                    detail=f"{obs.obs_id}: only {coverage:.0%} of the field covered, frame skipped",
                    affects=[f"obs:{obs.obs_id}"],
                )
            )
            continue
        wavelength, bandwidth = wavelength_at(path, ra, dec)
        kept.append((obs, url, coverage, wavelength, bandwidth))
        images.append(image)

    epochs = _epoch_groups(kept)
    checks += epoch_checks(len(kept), len(epochs))
    if stack:
        members = list(enumerate(epochs))
    else:
        members = [(epoch, [i]) for epoch, group in enumerate(epochs) for i in group]
    images = [stack_images([images[i] for i in group]) for _, group in members]

    out_dir = manifest_path(settings.cache_dir, key).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    names = render_png(images, out_dir) if images else []
    frames = [
        _frame(index, f"/api/frames/{key}/{name}", epoch, [kept[i] for i in group])
        for index, ((epoch, group), name) in enumerate(zip(members, names, strict=True))
    ]
    checks += wavelength_checks([frame.wavelength_um for frame in frames], detector)
    differences = []
    if stack:
        for a, b in combinations(range(len(images)), 2):
            name = f"diff_{a:02d}_{b:02d}.png"
            render_diff(images[a], images[b], out_dir, name)
            wave_a, wave_b = frames[a].wavelength_um, frames[b].wavelength_um
            known = wave_a is not None and wave_b is not None
            differences.append(
                Difference(
                    a=a,
                    b=b,
                    url=f"/api/frames/{key}/{name}",
                    comparable=comparable_wavelengths(wave_a, wave_b, detector) if known else True,
                    delta_lambda_pct=round(delta_lambda_pct(wave_a, wave_b), 2) if known else None,
                    obs_ids_a=[kept[i][0].obs_id for i in members[a][1]],
                    obs_ids_b=[kept[i][0].obs_id for i in members[b][1]],
                )
            )
    if any(difference.delta_lambda_pct is None for difference in differences):
        checks.append(
            Check(
                code="WAVELENGTH_UNKNOWN",
                severity="info",
                message="Wavelength match between epochs not checked",
                detail="Differences use the same detector, but a cutout carries no WCS-WAVE table, "
                "so whether both epochs saw the same wavelength at the target is unknown",
                affects=["difference"],
            )
        )
    manifest = FrameManifest(
        collection=settings.spherex_collection,
        ra=ra,
        dec=dec,
        size_deg=size_deg,
        detector=detector,
        pixel_scale_arcsec=SPHEREX_PIXEL_SCALE_ARCSEC,
        epochs=len(epochs),
        complete=len(downloaded) == len(selected),
        stacked=stack,
        pipeline_version=PIPELINE_VERSION,
        frames=frames,
        warnings=[check.detail for check in checks if check.severity != "info"],
        checks=checks,
        differences=differences,
    )
    partial = out_dir / "manifest.json.part"
    partial.write_text(manifest.model_dump_json())
    partial.replace(manifest_path(settings.cache_dir, key))
    return manifest.model_dump()


def stack_images(images: list[np.ndarray]) -> np.ndarray:
    """NaN-aware median of aligned exposures: noise averages out, cosmic rays vanish."""
    if len(images) == 1:
        return images[0]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels outside the footprint
        return np.nanmedian(np.stack(images), axis=0)


# One usable exposure: observation, cutout URL, coverage, wavelength and bandwidth at the target.
KeptFrame = tuple[Observation, str, float, float | None, float | None]


def _epoch_groups(kept: list[KeptFrame]) -> list[list[int]]:
    """Positions in `kept`, grouped by epoch and in time order."""
    position = {obs.obs_id: i for i, (obs, *_) in enumerate(kept)}
    return [[position[obs.obs_id] for obs in epoch] for epoch in group_epochs([k[0] for k in kept])]


def _frame(index: int, url: str, epoch: int, members: list[KeptFrame]) -> Frame:
    """One frame from a single exposure or from all exposures of one epoch stacked together."""
    observations = [obs for obs, *_ in members]
    first, last = observations[0], observations[-1]
    wavelengths = [w for *_, w, _ in members if w is not None]
    bandwidths = [b for *_, b in members if b is not None]
    return Frame(
        index=index,
        url=url,
        obs_id=first.obs_id,
        date=first.date,
        mjd=float(np.mean([obs.mjd for obs in observations])),
        detector=first.detector,
        wavelength_min_um=min(obs.wavelength_min_um for obs in observations),
        wavelength_max_um=max(obs.wavelength_max_um for obs in observations),
        coverage=round(float(np.mean([coverage for _, _, coverage, *_ in members])), 3),
        source_url=members[0][1],
        epoch=epoch,
        n_combined=len(members),
        date_end=last.date if len(members) > 1 else None,
        wavelength_um=round(float(np.median(wavelengths)), 4) if wavelengths else None,
        bandwidth_um=round(float(np.median(bandwidths)), 4) if bandwidths else None,
    )


def _report(done: int, total: int) -> None:
    job = get_current_job()
    if job is not None:
        job.meta.update(progress=done, total=total)
        job.save_meta()
