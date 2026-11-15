import warnings
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import combinations
from pathlib import Path

import httpx
import numpy as np
from rq import get_current_job

from app.archive import (
    collection_key,
    group_epochs,
    release_label,
    search_observations,
    select_for_stacks,
    select_frames,
    spherex_collections,
)
from app.catalogs import find_proper_motion, position_at
from app.config import Settings, get_settings
from app.frames import (
    R_BY_DETECTOR,
    SPHEREX_PIXEL_SCALE_ARCSEC,
    TARGET_FLAG_RADIUS_PX,
    WAVELENGTH_MATCH_FRACTION,
    align,
    comparable_wavelengths,
    cutout_url,
    delta_lambda_pct,
    failure_reason,
    fetch_cutout,
    read_image,
    render_diff,
    render_png,
    target_grid,
    target_is_flagged,
    wavelength_at,
)
from app.models import Check, Difference, Frame, FrameManifest, Observation, Spectrum, SpectrumPoint
from app.photometry import forced_photometry
from app.sources import find_sources

MIN_COVERAGE = 0.5
# Just the aperture and the sky ring around the target (about 25 px with the rotation margin).
SPECTRUM_SIZE_DEG = 0.03
# About one visit per spectral channel (6 detectors × 17): enough for a quick look, and a cold
# cache still finishes within the spectrum job timeout while IRSA is slow.
MAX_SPECTRUM_POINTS = 100
# Bump whenever the photometry changes: the spectrum job key changes, so results are rebuilt.
SPECTRUM_VERSION = 4
# Bump whenever the rendered output changes: the job key changes, so cached results are rebuilt,
# and `warm` removes frame folders whose manifest carries an older version.
PIPELINE_VERSION = 11


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
    if len(known) < 2:
        return []
    lo, hi = min(known), max(known)
    if comparable_wavelengths(lo, hi, detector, WAVELENGTH_MATCH_FRACTION):
        return []
    pct, r = delta_lambda_pct(lo, hi), R_BY_DETECTOR[detector]
    spread = (
        f"Effective wavelength ranges from {lo:.3f} to {hi:.3f} µm ({pct:.1f} %, "
        f"{pct * r / 100:.2f} resolution elements λ/R of detector {detector}, R = {r})"
    )
    if comparable_wavelengths(lo, hi, detector):
        return [
            Check(
                code="WAVELENGTH_CLOSE",
                severity="warning",
                message="Frames were observed at slightly different wavelengths",
                detail=f"{spread}: more than half a resolution element, so spectral features can "
                "mimic a brightness change; positions still compare",
                affects=["difference"],
            )
        ]
    return [
        Check(
            code="WAVELENGTH_MISMATCH",
            severity="blocker",
            message="Frames were observed at different wavelengths",
            detail=f"{spread}: more than one resolution element; "
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
    collections: list[str] | None = None,
) -> dict:
    """Worker job: find the observations, cut them out, align them and render the blink frames."""
    settings = get_settings()
    collections = collections or spherex_collections(settings)
    found, failed = search_observations(ra, dec, settings, collections)
    observations = [o for o in found if o.detector == detector]
    selected = select_for_stacks(observations) if stack else select_frames(observations, max_frames)
    urls = [cutout_url(o.access_url, ra, dec, size_deg) for o in selected]
    _report(0, len(selected))

    def publish_preview(downloaded, checks):
        # Separate files: a provisional stretch must never overwrite immutable final PNGs.
        count = len(downloaded)
        if count > 12 or (count not in (1, 2) and count % 4 != 0):
            return
        _render_frames(
            key,
            ra,
            dec,
            size_deg,
            detector,
            downloaded,
            list(checks),
            selected,
            failed,
            collections,
            settings,
            stack=False,
            preview=True,
        )

    # Start with widely separated dates; one slow cutout cannot block another ready image.
    if len(selected) > 2:
        selected = [selected[0], selected[-1], *selected[1:-1]]
        urls = [cutout_url(o.access_url, ra, dec, size_deg) for o in selected]
    downloaded, checks = download_cutouts(selected, urls, settings, on_ready=publish_preview)
    downloaded.sort(key=lambda item: item[0].mjd)
    return _render_frames(
        key,
        ra,
        dec,
        size_deg,
        detector,
        downloaded,
        checks,
        selected,
        failed,
        collections,
        settings,
        stack=stack,
    )


def _render_frames(
    key,
    ra,
    dec,
    size_deg,
    detector,
    downloaded,
    checks,
    selected,
    failed,
    collections,
    settings,
    *,
    stack=False,
    preview=False,
) -> dict:
    target, shape = target_grid(ra, dec, size_deg)
    kept, images = [], []
    for obs, url, path in downloaded:
        data, wcs, unusable = read_image(path)
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
        if target_is_flagged(unusable, wcs, ra, dec):
            checks.append(
                Check(
                    code="FLAGGED_PIXELS",
                    severity="warning",
                    message="Flagged pixels next to the target",
                    detail=f"{obs.obs_id}: unusable pixels within {TARGET_FLAG_RADIUS_PX} px "
                    "of the target, treat changes at the target in this frame with care",
                    affects=[f"obs:{obs.obs_id}"],
                )
            )
        wavelength, bandwidth = wavelength_at(path, ra, dec)
        kept.append((obs, url, coverage, wavelength, bandwidth, float(unusable.mean())))
        images.append(image)

    checks += release_checks([obs for obs, *_ in kept], failed)
    epochs = _epoch_groups(kept)
    checks += epoch_checks(len(kept), len(epochs))
    if stack:
        members = list(enumerate(epochs))
    else:
        members = [(epoch, [i]) for epoch, group in enumerate(epochs) for i in group]
    images = [stack_images([images[i] for i in group]) for _, group in members]

    out_dir = manifest_path(settings.cache_dir, key).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    names = (
        render_png(images, out_dir, prefix=f"preview_{len(downloaded):03d}_" if preview else "")
        if images
        else []
    )
    frames = [
        _frame(index, f"/api/frames/{key}/{name}", epoch, [kept[i] for i in group])
        for index, ((epoch, group), name) in enumerate(zip(members, names, strict=True))
    ]
    checks += wavelength_checks([frame.wavelength_um for frame in frames], detector)
    if not preview:
        found, source_checks = find_sources(
            images, [f.mjd for f in frames], target, shape, ra, dec, size_deg, settings.cache_dir
        )
        for frame, sources in zip(frames, found, strict=True):
            frame.sources = sources
        checks += source_checks
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
    if preview:
        checks.append(
            Check(
                code="PREVIEW",
                severity="blocker",
                message="Preview · more observations are loading",
                detail="Individual exposures with a provisional shared stretch. Source matching, "
                "final stacks and difference checks are not ready yet.",
                affects=["difference"],
            )
        )
    manifest = FrameManifest(
        collection=collection_key(collections),
        release=_releases([obs for obs, *_ in kept]),
        ra=ra,
        dec=dec,
        size_deg=size_deg,
        detector=detector,
        pixel_scale_arcsec=SPHEREX_PIXEL_SCALE_ARCSEC,
        epochs=len(epochs),
        # A release that did not answer is retried on the next request.
        complete=not preview and len(downloaded) == len(selected) and not failed,
        preview=preview,
        stacked=stack,
        pipeline_version=PIPELINE_VERSION,
        frames=frames,
        warnings=[check.detail for check in checks if check.severity != "info"],
        checks=checks,
        differences=differences,
    )
    destination = out_dir / ("preview.json" if preview else "manifest.json")
    partial = destination.with_suffix(".json.part")
    partial.write_text(manifest.model_dump_json())
    partial.replace(destination)
    return manifest.model_dump()


def build_spectrum(ra: float, dec: float, collections: list[str] | None = None) -> dict:
    """Worker job: flux at the target in every visit of every detector, against its wavelength."""
    settings = get_settings()
    collections = collections or spherex_collections(settings)
    observations, failed = search_observations(ra, dec, settings, collections)
    selected = select_frames(observations, MAX_SPECTRUM_POINTS)
    # A star with a known Gaia proper motion is measured where it stands on each visit's date.
    try:
        star, gaia_down = find_proper_motion(ra, dec, strict=True), False
    except httpx.HTTPError:
        star, gaia_down = None, True
    position = {o.obs_id: position_at(star, o.mjd) if star else (ra, dec) for o in selected}
    urls = [cutout_url(o.access_url, *position[o.obs_id], SPECTRUM_SIZE_DEG) for o in selected]
    _report(0, len(selected))
    downloaded, checks = download_cutouts(selected, urls, settings)
    checks += release_checks([obs for obs, _, _ in downloaded], failed)
    checks.append(
        Check(
            code="QUICK_LOOK_SPECTRUM",
            severity="info",
            message="Quick-look spectrum, not calibrated",
            detail="Aperture flux (2 px radius) at the target without aperture correction: the PSF "
            "changes between detectors, so the shape across detectors is approximate",
        )
    )
    if len(selected) < len(observations):
        checks.append(
            Check(
                code="SPECTRUM_THINNED",
                severity="info",
                message="Not every visit is used",
                detail=f"{len(selected)} of {len(observations)} visits, spread over all epochs",
            )
        )
    if star:
        motion = np.hypot(star.pmra_mas_yr, star.pmdec_mas_yr)
        checks.append(
            Check(
                code="SPECTRUM_PROPER_MOTION",
                severity="info",
                message="Target followed with its proper motion",
                detail=f"Gaia DR3 {star.source_id} ({motion:.0f} mas/yr): aperture placed at the "
                "star's position on each visit's date",
            )
        )
    if gaia_down:
        checks.append(
            Check(
                code="SPECTRUM_GAIA_UNAVAILABLE",
                severity="warning",
                message="Proper motion unknown",
                detail="Gaia DR3 did not answer: measured at the entered position, so a fast "
                "moving star may lie outside the aperture (building the spectrum again retries)",
            )
        )
    epoch_of = {o.obs_id: i for i, epoch in enumerate(group_epochs(selected)) for o in epoch}

    points, skipped = [], Counter[str]()
    for obs, url, path in downloaded:
        wavelength, bandwidth = wavelength_at(path, *position[obs.obs_id])
        measured = forced_photometry(path, *position[obs.obs_id])
        if isinstance(measured, str) or wavelength is None:
            skipped[measured if isinstance(measured, str) else "no WCS-WAVE table"] += 1
            continue
        flux, error, flagged = measured
        points.append(
            SpectrumPoint(
                obs_id=obs.obs_id,
                date=obs.date,
                mjd=obs.mjd,
                detector=obs.detector,
                epoch=epoch_of[obs.obs_id],
                wavelength_um=round(wavelength, 4),
                bandwidth_um=round(bandwidth, 4),
                flux_ujy=round(flux, 2),
                flux_err_ujy=round(error, 2),
                flagged=flagged,
                source_url=url,
            )
        )
    if flagged_count := sum(point.flagged for point in points):
        checks.append(
            Check(
                code="SPECTRUM_POINTS_FLAGGED",
                severity="info",
                message="Some points have flagged pixels in the aperture",
                detail=f"{flagged_count} of {len(points)} points have flagged pixels in the "
                "aperture (e.g. saturation): drawn hollow, their flux is unreliable",
            )
        )
    if skipped:
        checks.append(
            Check(
                code="SPECTRUM_POINTS_SKIPPED",
                severity="info",
                message="Some visits give no spectrum point",
                detail=f"{skipped.total()} visits skipped: "
                + ", ".join(f"{n} {reason}" for reason, n in skipped.most_common()),
            )
        )
    return Spectrum(
        collection=collection_key(collections),
        ra=ra,
        dec=dec,
        complete=len(downloaded) == len(selected) and not gaia_down and not failed,
        points=sorted(points, key=lambda point: point.wavelength_um),
        checks=checks,
    ).model_dump()


def download_cutouts(
    selected: list[Observation],
    urls: list[str],
    settings: Settings,
    on_ready: Callable | None = None,
) -> tuple[list[tuple[Observation, str, Path]], list[Check]]:
    """Fetch the cutouts in parallel; a cutout the archive does not deliver becomes a check."""
    checks: list[Check] = []
    downloaded = []
    with (
        httpx.Client(timeout=settings.http_timeout_s, follow_redirects=True) as client,
        ThreadPoolExecutor(max_workers=settings.download_workers) as pool,
    ):
        futures = {
            pool.submit(fetch_cutout, client, url, settings.cache_dir / "cutouts"): (obs, url)
            for obs, url in zip(selected, urls, strict=True)
        }
        for done, future in enumerate(as_completed(futures), start=1):
            obs, url = futures[future]
            try:
                downloaded.append((obs, url, future.result()))
            except httpx.HTTPError as exc:
                checks.append(
                    Check(
                        code="CUTOUT_MISSING",
                        severity="warning",
                        message="Archive did not deliver a cutout",
                        detail=f"{obs.obs_id}: archive did not deliver the cutout "
                        f"({failure_reason(exc, settings.http_timeout_s)}), frame skipped "
                        "(requesting the same view again retries it)",
                        affects=[f"obs:{obs.obs_id}"],
                    )
                )
            _report(done, len(selected))
            if on_ready and downloaded and done < len(selected):
                on_ready(sorted(downloaded, key=lambda item: item[0].mjd), checks)
    downloaded.sort(key=lambda item: item[0].mjd)
    return downloaded, checks


def stack_images(images: list[np.ndarray]) -> np.ndarray:
    """NaN-aware median of aligned exposures: noise averages out, cosmic rays vanish."""
    if len(images) == 1:
        return images[0]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels outside the footprint
        return np.nanmedian(np.stack(images), axis=0)


# One usable exposure: observation, cutout URL, coverage, wavelength and bandwidth at the
# target, share of unusable pixels.
KeptFrame = tuple[Observation, str, float, float | None, float | None, float]


def _epoch_groups(kept: list[KeptFrame]) -> list[list[int]]:
    """Positions in `kept`, grouped by epoch and in time order."""
    position = {obs.obs_id: i for i, (obs, *_) in enumerate(kept)}
    return [[position[obs.obs_id] for obs in epoch] for epoch in group_epochs([k[0] for k in kept])]


def _frame(index: int, url: str, epoch: int, members: list[KeptFrame]) -> Frame:
    """One frame from a single exposure or from all exposures of one epoch stacked together."""
    observations = [obs for obs, *_ in members]
    first, last = observations[0], observations[-1]
    wavelengths = [w for *_, w, _, _ in members if w is not None]
    bandwidths = [b for *_, b, _ in members if b is not None]
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
        cloud_url=first.cloud_url,
        epoch=epoch,
        n_combined=len(members),
        date_end=last.date if len(members) > 1 else None,
        wavelength_um=round(float(np.median(wavelengths)), 4) if wavelengths else None,
        bandwidth_um=round(float(np.median(bandwidths)), 4) if bandwidths else None,
        masked_fraction=round(float(np.mean([masked for *_, masked in members])), 3),
        release=_releases(observations),
    )


def _releases(observations: list[Observation]) -> str | None:
    labels = {release_label(o.collection) for o in observations if o.collection}
    return " + ".join(sorted(labels)) or None


def release_checks(observations: list[Observation], failed: list[str]) -> list[Check]:
    """Never mix releases silently, and say which release could not be searched."""
    checks = [
        Check(
            code="RELEASE_UNAVAILABLE",
            severity="warning",
            message=f"SPHEREx {release_label(collection)} could not be searched",
            detail=f"The archive did not answer for {collection}: its observations are missing",
        )
        for collection in failed
    ]
    releases = _releases(observations)
    # A deep field shares its release's calibration: only DR1 against QR3 counts as a mix.
    if releases and len({label.split()[0] for label in releases.split(" + ")}) > 1:
        checks.append(
            Check(
                code="MIXED_RELEASES",
                severity="info",
                message=f"Mixed releases: {releases} (different calibration versions)",
                detail=f"Frames come from SPHEREx {releases}: the releases are processed with "
                "different calibration versions, so small brightness steps between them are "
                "expected and need checking before they count as a change",
            )
        )
    return checks


def _report(done: int, total: int) -> None:
    job = get_current_job()
    if job is not None:
        job.meta.update(progress=done, total=total)
        job.save_meta()
