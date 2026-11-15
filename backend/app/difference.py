"""Changes between the blink's A and B (worker job): B registered onto A on field stars, the flux
ratio fitted on them, then the PSF-matched significance S_corr of ZOGY (Zackay, Ofek & Gal-Yam
2016, ApJ 830, 27) with each frame's ePSF, or without one the difference over its noise. Every
peak of |S| ≥ 5 is a residual, explained where a known asteroid, a bright star or a catalogue
source of the frames lies there; otherwise it needs verification. S is positive where B is
brighter. A and B are the frames job's aligned frames (aligned_NN.npz); a job from before them
gets them by aligning its cached cutouts once more, as the frames job did.

The constants and functions between the SHARED markers are copied verbatim from
analysis-service/app/analysis.py and imaging.py (the services share no code): change both
together, tests/test_difference.py compares them. Grid, Cutout, StoredFrame and Check give them
the attributes they read there.
"""

import hashlib
import math
import os
import uuid
import warnings
from pathlib import Path
from typing import NamedTuple

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from photutils.centroids import centroid_com, centroid_sources
from photutils.detection import find_peaks
from reproject import reproject_interp
from scipy import ndimage

from app import models
from app.archive import ArchiveError, search_observations
from app.config import Settings, get_settings
from app.frames import (
    R_BY_DETECTOR,
    WAVELENGTH_MATCH_FRACTION,
    Aligned,
    align,
    aligned_path,
    comparable_wavelengths,
    cutout_path,
    cutout_url,
    delta_lambda_pct,
    load_aligned,
    read_image,
    render_signed,
    save_aligned,
    target_grid,
)
from app.models import DetectedSource, Frame, FrameManifest, PairDifference, Residual
from app.psf import EPSF, cutout_epsf, pixel_psf, zogy
from app.tasks import manifest_path, stack_images, stack_weights

# Bump whenever the result changes: job ids, cached results and image names change with it.
DIFFERENCE_VERSION = 1
# The significance image spans ±S_LIMIT σ, the difference ±D_LIMIT times its clipped scatter.
S_LIMIT = 7.0
D_LIMIT = 5.0
# A and B share data on less of the field: its edges are not meaningful.
OVERLAP_WARN = 0.9
# JPL's rates are linear motion, fine for hours: as frontend/src/smallBodyLayer.ts MAX_GAP_DAYS.
SMALL_BODY_GAP_DAYS = 1.0
# A saturated star without a Gaia G counts as this bright: its zone is bright_radius_px of it.
SATURATED_G = 8.0
# A catalogue source detected in A and B this far apart moved between them.
MOVED_PX = 0.5
# Peaks this close to a pixel without data in A or B are left out: a masked star core or an
# artefact's rim leaves residuals there (15 of 17 peaks in 15 real D2 pairs lay next to one).
MASK_MARGIN_PX = 1


class PairUnavailableError(Exception):
    """A frame of the pair can be neither read nor aligned again from cached cutouts."""


class Grid(NamedTuple):
    """The frames' target grid, as imaging.grid_psf reads it."""

    wcs: WCS
    npix: int


class Cutout(NamedTuple):
    """A cached cutout as imaging.grid_psf reads it: its pixel grid, WCS and the ePSF at the
    target."""

    image: np.ndarray
    wcs: WCS
    psf: EPSF | None


class StoredFrame(NamedTuple):
    """A or B on the target grid, as the blocks of analysis.py read it."""

    meta: Frame
    image: np.ndarray
    variance: np.ndarray
    hard_mask: np.ndarray  # no usable data
    flags: None
    grid: Grid
    target: None
    flag_names: dict[int, str]
    psf: np.ndarray | None  # grid PSF stamp, None without an ePSF


class Check(NamedTuple):
    """A check in the analysis service's form (register makes one); see _check."""

    code: str
    severity: str
    title: str
    detail: str


# SHARED: analysis-service/app/analysis.py
RESIDUAL_SIGMA = 5.0
SSO_PARALLAX_ARCSEC = 10.0
# Fainter known objects are below SPHEREx single-visit sensitivity: never an explanation.
SSO_VMAG_LIMIT = 21.0
# Fractional systematic error added in quadrature in the significance map (QUALITY.md).
SYSTEMATIC_FRACTION = 0.05
MATCH_RADIUS_PX = 1.5
BRIGHT_G = 12.0
REGISTRATION_MIN_STARS = 5
# Registration noise for ZOGY when too few stars measure it: 0.2 px (1.2″), a conservative guess
# for a WCS-only alignment. The term only lowers S next to bright sources, so overestimating it
# costs little sensitivity; underestimating it turns every star into a dipole residual.
UNMEASURED_REGISTRATION_PX = 0.2


def _filled(variance: np.ndarray, bad: np.ndarray) -> np.ndarray:
    """Variance with masked or missing pixels set to the median of the rest."""
    good = ~bad & np.isfinite(variance)
    return np.where(good, variance, np.median(variance[good]) if good.any() else 1.0)


def _find_residual_peaks(sig: np.ndarray, bad: np.ndarray) -> list[tuple[float, float, float]]:
    """(x, y, significance) of |S| local maxima above RESIDUAL_SIGMA, FITS pixel coords."""
    data = np.where(bad, 0.0, np.abs(np.nan_to_num(sig)))
    border = np.zeros_like(bad)
    border[:2, :] = border[-2:, :] = border[:, :2] = border[:, -2:] = True
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        peaks = find_peaks(data, threshold=RESIDUAL_SIGMA, box_size=3, npeaks=25, mask=bad | border)
    if peaks is None:
        return []
    out = []
    for row in peaks:
        x, y = float(row["x_peak"]), float(row["y_peak"])
        out.append((x, y, float(sig[int(y), int(x)])))
    return out


def bright_radius_px(g_mag: float) -> float:
    """Zone of influence of a bright star (PSF wings, saturation, bleed) in pixels.
    Grows with brightness: G=12 → 2 px, G=10 → 5 px, G=8 → 8 px (capped at 12)."""
    return float(min(12.0, 2.0 + 1.5 * (BRIGHT_G - g_mag)))


def measure_offset(a: StoredFrame, b: StoredFrame) -> tuple[float, float, float, int]:
    """Median sub-pixel offset (B − A) of bright, isolated field stars, its scatter, and
    the number of stars used. Movers are rejected by sigma clipping."""
    with np.errstate(invalid="ignore", divide="ignore"):
        snr = np.where(a.hard_mask | b.hard_mask, 0.0, np.nan_to_num(a.image / np.sqrt(a.variance)))
    border = np.zeros_like(a.hard_mask)
    border[:4, :] = border[-4:, :] = border[:, :4] = border[:, -4:] = True
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        peaks = find_peaks(snr, threshold=15.0, box_size=7, npeaks=60, mask=border)
    if peaks is None or len(peaks) < REGISTRATION_MIN_STARS:
        return 0.0, 0.0, float("nan"), 0 if peaks is None else len(peaks)
    x, y = np.asarray(peaks["x_peak"], float), np.asarray(peaks["y_peak"], float)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        xa, ya = centroid_sources(
            np.nan_to_num(a.image), x, y, box_size=5, centroid_func=centroid_com
        )
        xb, yb = centroid_sources(
            np.nan_to_num(b.image), x, y, box_size=5, centroid_func=centroid_com
        )
    dx, dy = xb - xa, yb - ya
    ok = np.isfinite(dx) & np.isfinite(dy)
    if ok.sum() < REGISTRATION_MIN_STARS:
        return 0.0, 0.0, float("nan"), int(ok.sum())
    dx, dy = dx[ok], dy[ok]
    _, mx, sx = sigma_clipped_stats(dx, sigma=2.5)
    _, my, sy = sigma_clipped_stats(dy, sigma=2.5)
    return float(mx), float(my), float(math.hypot(sx, sy) / math.sqrt(ok.sum())), int(ok.sum())


def register(a: StoredFrame, b: StoredFrame) -> tuple[StoredFrame, Check, float]:
    """Refine the WCS alignment of B onto A with a sub-pixel shift measured on field stars.

    SPHEREx pixels (6.15") barely sample the PSF (~7" FWHM), so small WCS differences
    between releases or detector positions leave dipoles on every star after
    subtraction. We measure and remove the residual shift, and report it, with the
    registration noise for ZOGY in pixels: the per-axis scatter of single stars' offsets (it
    holds centroid noise and local distortion that one shift cannot remove), or
    UNMEASURED_REGISTRATION_PX without enough stars."""
    dx, dy, err, n = measure_offset(a, b)
    if n < REGISTRATION_MIN_STARS:
        return (
            b,
            Check(
                code="registration",
                severity="info",
                title=f"Alignment from WCS only ({n} reference stars)",
                detail="Too few bright isolated stars to verify the alignment.",
            ),
            UNMEASURED_REGISTRATION_PX,
        )
    scatter = err * math.sqrt(n / 2)  # err is the error of the mean of both axes
    shift = math.hypot(dx, dy)
    if shift < 0.05:
        return (
            b,
            Check(
                code="registration",
                severity="ok",
                title=f"WCS alignment verified: {shift:.2f} px residual",
                detail=f"Measured on {n} field stars (±{err:.2f} px).",
            ),
            math.hypot(shift, scatter),
        )
    shifted_img = ndimage.shift(np.nan_to_num(b.image), (-dy, -dx), order=3, mode="nearest")
    shifted_var = ndimage.shift(
        np.nan_to_num(b.variance, nan=np.nanmax(b.variance)), (-dy, -dx), order=1, mode="nearest"
    )
    shifted_bad = (
        ndimage.shift(b.hard_mask.astype(float), (-dy, -dx), order=0, mode="nearest") > 0.5
    )
    b2 = StoredFrame(
        b.meta,
        np.where(shifted_bad, np.nan, shifted_img),
        shifted_var,
        shifted_bad,
        b.flags,
        b.grid,
        b.target,
        b.flag_names,
        b.psf,
    )
    sev = "ok" if shift <= 0.5 else "warn"
    return (
        b2,
        Check(
            code="registration",
            severity=sev,
            title=f"B re-aligned by ({dx:+.2f}, {dy:+.2f}) px",
            detail=f"Residual WCS offset measured on {n} field stars (±{err:.2f} px) and "
            "removed before subtraction."
            + (
                " Offset above 0.5 px: check the astrometry of these frames."
                if sev == "warn"
                else ""
            ),
        ),
        scatter,
    )


def photometric_scale(a: StoredFrame, b: StoredFrame) -> tuple[float, int]:
    """Robust A/B flux ratio from pixels detected at >10σ in both frames. With a PSF for
    both, each frame is first convolved with the other one's PSF: a PSF difference would
    otherwise bias the pixel ratios of stars."""
    img_a, var_a, img_b, var_b = a.image, a.variance, b.image, b.variance
    if a.psf is not None and b.psf is not None:
        img_a, var_a = _convolved(a, b.psf)
        img_b, var_b = _convolved(b, a.psf)
    with np.errstate(invalid="ignore", divide="ignore"):
        snr_a = img_a / np.sqrt(var_a)
        snr_b = img_b / np.sqrt(var_b)
        ok = (~a.hard_mask) & (~b.hard_mask) & (snr_a > 10) & (snr_b > 10)
        ratios = img_a[ok] / img_b[ok]
    ratios = ratios[np.isfinite(ratios)]
    if ratios.size < 20:
        return 1.0, int(ratios.size)
    _, med, _ = sigma_clipped_stats(ratios, sigma=3.0)
    return float(med), int(ratios.size)


def _convolved(f: StoredFrame, kernel: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    image = ndimage.convolve(np.nan_to_num(f.image), kernel, mode="constant")
    variance = ndimage.convolve(np.nan_to_num(f.variance), kernel**2, mode="constant")
    return image, variance


# SHARED: analysis-service/app/imaging.py
def grid_psf(cutout: Cutout, grid: Grid, size: int = 11, spacing: int = 12) -> np.ndarray | None:
    """PSF of the aligned frame: a size × size stamp with sum 1, centred on its middle pixel.

    Unit point sources at grid pixel centres across the field are drawn on the cutout's pixels
    with its ePSF and resampled like align, then averaged. So the stamp holds the detector's
    rotation and the smoothing of the bilinear interpolation at this field's own sub-pixel
    phases (none where the pixel grids coincide). None without an ePSF."""
    if cutout.psf is None:
        return None
    half = size // 2
    centres = np.arange(half + 1, grid.npix - half - 1, spacing)
    gx, gy = (c.ravel() for c in np.meshgrid(centres, centres))
    cx, cy = cutout.wcs.world_to_pixel_values(*grid.wcs.pixel_to_world_values(gx, gy))
    image = np.zeros(cutout.image.shape)
    for x, y in zip(cx, cy, strict=True):
        image += pixel_psf(cutout.psf, float(x), float(y), image.shape)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        shape = (grid.npix, grid.npix)
        drawn, _ = reproject_interp((image, cutout.wcs), grid.wcs, shape, order="bilinear")
    stamps = [
        drawn[y - half : y + half + 1, x - half : x + half + 1] for x, y in zip(gx, gy, strict=True)
    ]
    stamps = [st for st in stamps if np.isfinite(st).all() and st.sum() > 0.9]
    if not stamps:
        return None
    stamp = np.mean(stamps, axis=0)
    return stamp / stamp.sum()


# END SHARED


def result_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / "differences" / f"{key}.json"


def pair_revision(folder: Path, manifest: FrameManifest, a: int, b: int) -> str:
    """Identify the actual input manifest and aligned pixels, including rebuilt partial jobs."""
    digest = hashlib.sha256(manifest.model_dump_json().encode())
    for index in (a, b):
        path = aligned_path(folder, index)
        if path.is_file():
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()[:16]


def image_names(a: int, b: int, revision: str = "") -> tuple[str, str]:
    """The significance and the difference image of A and B in the frames job's folder."""
    return (
        f"pairsig_{a:02d}_{b:02d}_v{DIFFERENCE_VERSION}{revision}.png",
        f"pairdiff_{a:02d}_{b:02d}_v{DIFFERENCE_VERSION}{revision}.png",
    )


def build_difference(
    key: str,
    job_id: str,
    a: int,
    b: int,
    small_bodies: list[dict] | None = None,
    revision: str | None = None,
) -> dict:
    """Worker job: the changes between frames a and b of a finished frames job. small_bodies:
    the epochs of a finished SBIdent lookup of the same comparison, None without one."""
    settings = get_settings()
    folder = manifest_path(settings.cache_dir, job_id).parent
    manifest = FrameManifest.model_validate_json((folder / "manifest.json").read_text())
    if revision is not None and pair_revision(folder, manifest, a, b) != revision:
        raise PairUnavailableError("The images changed: request this pair again")
    epochs = (
        None
        if small_bodies is None
        else [models.SmallBodyEpoch.model_validate(epoch) for epoch in small_bodies]
    )
    result = find_changes(folder, manifest, job_id, a, b, epochs, settings)
    current_manifest = FrameManifest.model_validate_json((folder / "manifest.json").read_text())
    if revision is not None and pair_revision(folder, current_manifest, a, b) != revision:
        raise PairUnavailableError("The images changed during processing: request this pair again")
    path = result_path(settings.cache_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.part")
    partial.write_text(result.model_dump_json())
    partial.replace(path)
    return result.model_dump()


def find_changes(
    folder: Path,
    manifest: FrameManifest,
    job_id: str,
    a: int,
    b: int,
    small_bodies: list[models.SmallBodyEpoch] | None,
    settings: Settings,
) -> PairDifference:
    revision = pair_revision(folder, manifest, a, b)
    target, shape = target_grid(manifest.ra, manifest.dec, manifest.size_deg)
    grid = Grid(target, shape[0])
    frame_a, frame_b = (_stored(folder, manifest, index, grid, settings) for index in (a, b))
    matched = frame_a.psf is not None and frame_b.psf is not None
    checks = _method_checks(frame_a, frame_b, matched)
    checks += pair_checks(manifest, frame_a.meta, frame_b.meta)
    checks.append(_overlap_check(float((~frame_a.hard_mask & ~frame_b.hard_mask).mean())))
    frame_b, registration, registration_px = register(frame_a, frame_b)
    checks.append(_check(registration, "PAIR_REGISTRATION"))
    scale, n_scale = photometric_scale(frame_b, frame_a)
    reliable = n_scale >= 20 and 0.67 < scale < 1.5
    checks.append(
        models.Check(
            code="PAIR_SCALE",
            severity="info" if reliable else "warning",
            message=f"A scaled ×{scale:.3f} to match B",
            detail=f"Robust flux ratio from {n_scale} high-S/N pixels (field stars): it removes "
            "calibration and wavelength offsets before the subtraction"
            if n_scale >= 20
            else "Too few bright pixels to fit a flux ratio reliably: ×1 assumed",
        )
    )
    sig, diff, rescale = significance(frame_a, frame_b, scale, registration_px, matched)
    sig_name, diff_name = image_names(a, b, "_" + revision)
    render_signed(sig, S_LIMIT, folder, sig_name)
    finite = diff[np.isfinite(diff)]
    spread = float(sigma_clipped_stats(finite)[2]) if finite.size else 0.0
    render_signed(diff, D_LIMIT * spread, folder, diff_name)

    blockers = [check for check in checks if check.severity == "blocker"]
    # A stack spans days: JPL's linear rates do not place a body in it.
    bodies = [
        _bodies_at(small_bodies, frame.meta)
        if small_bodies is not None and frame.meta.n_combined == 1
        else None
        for frame in (frame_a, frame_b)
    ]
    checked = all(found is not None for found in bodies)
    margin = np.ones((2 * MASK_MARGIN_PX + 1,) * 2, dtype=bool)
    bad = ndimage.binary_dilation(~np.isfinite(sig), structure=margin)
    residuals = []
    if not blockers:
        residuals = [
            _explain(x, y, s, grid, manifest, frame_a.meta, frame_b.meta, bodies, checked)
            for x, y, s in _find_residual_peaks(sig, bad)
        ]
        residuals.sort(key=lambda r: -abs(r.significance))
    searched = float((~bad).mean())
    checks.append(
        _residual_check(residuals, matched, registration_px, rescale, searched, bool(blockers))
    )
    wave_a, wave_b = frame_a.meta.wavelength_um, frame_b.meta.wavelength_um
    return PairDifference(
        job_id=job_id,
        a=a,
        b=b,
        comparable=not blockers,
        reason=blockers[0].message if blockers else None,
        method="zogy" if matched else "direct",
        significance_url=f"/api/frames/{job_id}/{sig_name}",
        difference_url=f"/api/frames/{job_id}/{diff_name}",
        delta_days=round(frame_b.meta.mjd - frame_a.meta.mjd, 5),
        delta_lambda_pct=None
        if wave_a is None or wave_b is None
        else round(delta_lambda_pct(wave_a, wave_b), 3),
        small_bodies_checked=checked,
        residuals=residuals,
        checks=checks,
    )


def _stored(
    folder: Path, manifest: FrameManifest, index: int, grid: Grid, settings: Settings
) -> StoredFrame:
    cutout_dir = settings.cache_dir / "cutouts"
    path = aligned_path(folder, index)
    if path.is_file():
        aligned, cutouts, weights = load_aligned(path)
    else:
        aligned, cutouts, weights = _realign(manifest, index, grid, settings)
        save_aligned(path, aligned, cutouts, weights)
    psf = frame_psf([cutout_dir / name for name in cutouts], weights, grid, manifest)
    return StoredFrame(
        manifest.frames[index],
        aligned.image,
        aligned.variance,
        ~np.isfinite(aligned.image) | ~(aligned.variance > 0),
        None,
        grid,
        None,
        {},
        psf,
    )


def _realign(
    manifest: FrameManifest, index: int, grid: Grid, settings: Settings
) -> tuple[Aligned, list[str], np.ndarray]:
    """A frame of a job from before the aligned frames were kept: its cached cutouts aligned and
    stacked once more with the frames job's own steps. An exposure's cutout is its source_url; a
    stack's exposures are named in the job's differences and found in the stored archive search."""
    frame = manifest.frames[index]
    cutout_dir = settings.cache_dir / "cutouts"
    if frame.n_combined == 1:
        paths = [cutout_path(cutout_dir, frame.source_url)]
    else:
        paths = _stack_cutouts(manifest, index, settings)
    if not paths or not all(path.is_file() for path in paths):
        raise PairUnavailableError(
            f"The cutouts of image {index + 1} are no longer cached, so the changes of this pair "
            "cannot be found"
        )
    target, shape = grid.wcs, (grid.npix, grid.npix)
    exposures = [align(*read_image(path)[:3], target, shape) for path in paths]
    return stack_images(exposures), [path.name for path in paths], stack_weights(exposures)


def _stack_cutouts(manifest: FrameManifest, index: int, settings: Settings) -> list[Path]:
    """The cached cutouts of a stack's exposures, in the order the frames job stacked them; an
    exposure listed in two releases is the one whose cutout is cached."""
    members = next(
        (
            d.obs_ids_a if d.a == index else d.obs_ids_b
            for d in manifest.differences
            if index in (d.a, d.b)
        ),
        [],
    )
    try:
        found, _ = search_observations(
            manifest.ra, manifest.dec, settings, manifest.collection.split(",")
        )
    except ArchiveError as exc:
        raise PairUnavailableError(
            "The archive search of this comparison is not stored and IRSA did not answer, so its "
            "stacks cannot be aligned again for the changes"
        ) from exc
    cutout_dir = settings.cache_dir / "cutouts"
    paths = []
    for obs_id in members:
        cached = [
            path
            for o in found
            if o.obs_id == obs_id and o.detector == manifest.detector
            for path in [
                cutout_path(
                    cutout_dir,
                    cutout_url(o.access_url, manifest.ra, manifest.dec, manifest.size_deg),
                )
            ]
            if path.is_file()
        ]
        if not cached:
            return []
        paths.append(cached[0])
    return paths


def frame_psf(
    cutouts: list[Path], weights: np.ndarray, grid: Grid, manifest: FrameManifest
) -> np.ndarray | None:
    """The frame's PSF on the grid: the ePSF of each exposure's detector zone at the target,
    drawn and resampled like its pixels (grid_psf), averaged with the stack weights. None when
    an exposure has no ePSF (or its cutout is no longer cached)."""
    stamps = []
    for path in cutouts:
        found = cutout_epsf(path, manifest.ra, manifest.dec) if path.is_file() else None
        if found is None:
            return None
        model, wcs, shape = found
        stamp = grid_psf(Cutout(np.broadcast_to(0.0, shape), wcs, model), grid)
        if stamp is None:
            return None
        stamps.append(stamp)
    return np.average(stamps, axis=0, weights=weights) if stamps else None


def significance(
    a: StoredFrame, b: StoredFrame, scale: float, registration_px: float, matched: bool
) -> tuple[np.ndarray, np.ndarray, float]:
    """S of B against A (positive where B is brighter), B − scale·A and the factor S was
    divided by, as analysis.difference computes them with A and B swapped."""
    diff = b.image - scale * a.image
    bad = a.hard_mask | b.hard_mask
    if matched:
        sig = zogy(
            np.where(bad, 0.0, np.nan_to_num(b.image)),
            np.where(bad, 0.0, np.nan_to_num(a.image)),
            _filled(b.variance, bad),
            _filled(a.variance, bad),
            b.psf,
            a.psf,
            flux_ratio=scale,
            sigma_ast=registration_px,
            floor=SYSTEMATIC_FRACTION,
        )
    else:
        with np.errstate(invalid="ignore", divide="ignore"):
            # Without the floor every bright star is a residual: the PSFs of A and B differ, and
            # so do the calibrations.
            local = np.maximum(np.abs(b.image), np.abs(scale * a.image))
            sig = diff / np.sqrt(
                b.variance + scale**2 * a.variance + (SYSTEMATIC_FRACTION * local) ** 2
            )
    bad = bad | ~np.isfinite(sig)
    diff = np.where(bad, np.nan, diff)
    sig = np.where(bad, np.nan, sig)
    # The variances leave out the pixel covariance of resampling and stacking: S is scaled to a
    # robust scatter of 1, never up.
    rescale = 1.0
    if np.isfinite(sig).sum() > 50:
        rescale = max(1.0, float(sigma_clipped_stats(sig[np.isfinite(sig)], sigma=3.0)[2]))
        sig = sig / rescale
    return sig, diff, rescale


def pair_checks(manifest: FrameManifest, a: Frame, b: Frame) -> list[models.Check]:
    """Wavelength (the rule of the frame checks, frames.py), time baseline and releases."""
    checks = [_wavelength_check(a.wavelength_um, b.wavelength_um, manifest.detector)]
    days = abs(b.mjd - a.mjd)
    span = f"{days * 24:.1f} h" if days < 2 else f"{days:.0f} days"
    if a.epoch == b.epoch:
        checks.append(
            models.Check(
                code="PAIR_SAME_EPOCH",
                severity="warning",
                message=f"A and B are from the same epoch, {span} apart",
                detail="Only fast movers (asteroids, comets) move in this time; brightness "
                "differences within an epoch are mostly wavelength changes",
            )
        )
    else:
        checks.append(
            models.Check(
                code="PAIR_BASELINE",
                severity="info",
                message=f"A and B are {span} apart",
                detail="A source moving more than one pixel (6.15″) in this time shows as a pair "
                "of opposite residuals",
            )
        )
    # A deep field shares its release's calibration: only DR1 against QR3 counts as a mix.
    families = [{label.split()[0] for label in f.release.split(" + ")} for f in (a, b) if f.release]
    if len(families) == 2 and families[0] != families[1]:
        checks.append(
            models.Check(
                code="PAIR_MIXED_RELEASES",
                severity="info",
                message=f"A and B come from different releases ({a.release} and {b.release})",
                detail="The releases are processed with different calibration versions, so small "
                "brightness steps between them are expected",
            )
        )
    return checks


def _wavelength_check(a_um: float | None, b_um: float | None, detector: int) -> models.Check:
    if a_um is None or b_um is None:
        return models.Check(
            code="PAIR_WAVELENGTH_UNKNOWN",
            severity="info",
            message="Wavelength match of A and B not checked",
            detail="A cutout carries no WCS-WAVE table, so whether A and B saw the same "
            "wavelength at the target is unknown",
        )
    pct, r = delta_lambda_pct(a_um, b_um), R_BY_DETECTOR[detector]
    spread = (
        f"{a_um:.3f} and {b_um:.3f} µm, Δλ {pct:.2f} % ({pct * r / 100:.2f} resolution elements "
        f"λ/R of detector {detector}, R = {r})"
    )
    if comparable_wavelengths(a_um, b_um, detector, WAVELENGTH_MATCH_FRACTION):
        return models.Check(
            code="PAIR_WAVELENGTH",
            severity="info",
            message="A and B were observed at the same wavelength",
            detail=f"{spread}: within half a resolution element",
        )
    if comparable_wavelengths(a_um, b_um, detector):
        return models.Check(
            code="PAIR_WAVELENGTH_CLOSE",
            severity="warning",
            message="A and B were observed at slightly different wavelengths",
            detail=f"{spread}: more than half a resolution element, so spectral features can "
            "mimic a brightness change; positions still compare",
            affects=["difference"],
        )
    return models.Check(
        code="PAIR_WAVELENGTH_MISMATCH",
        severity="blocker",
        message=f"A and B were observed at different wavelengths (Δλ {pct:.1f} %)",
        detail=f"{spread}: more than one resolution element; a difference needs "
        "wavelength-matched frames, so choose a compatible pair",
        affects=["difference"],
    )


def _overlap_check(overlap: float) -> models.Check:
    if overlap == 0:
        return models.Check(
            code="PAIR_NO_OVERLAP",
            severity="blocker",
            message="A and B share no usable pixels",
            detail="Their footprints or masks do not overlap on the grid",
            affects=["difference"],
        )
    return models.Check(
        code="PAIR_OVERLAP",
        severity="info" if overlap >= OVERLAP_WARN else "warning",
        message=f"A and B share data on {overlap:.0%} of the field",
        detail="Pixels without data in A or B (outside a footprint, masked) are left out"
        + ("" if overlap >= OVERLAP_WARN else "; changes at their edges are not meaningful"),
    )


def _method_checks(a: StoredFrame, b: StoredFrame, matched: bool) -> list[models.Check]:
    if matched:
        return [
            models.Check(
                code="PAIR_METHOD",
                severity="info",
                message="Significance: PSF-matched difference (ZOGY)",
                detail="Zackay, Ofek & Gal-Yam 2016 (ApJ 830, 27): A and B are matched with their "
                "SPHEREx ePSFs (each exposure's detector zone at the target, resampled onto the "
                "grid like its pixels; a stack uses the weighted mean of its exposures). That "
                "removes most of what a PSF difference leaves at stars: the resampled PSF changes "
                "from star to star with the sub-pixel position, which a 5 % floor absorbs, so "
                "very bright stars can still leave residuals. S is the corrected score S_corr",
            )
        ]
    missing = " and ".join(name for name, f in (("A", a), ("B", b)) if f.psf is None)
    return [
        models.Check(
            code="PAIR_METHOD",
            severity="info",
            message="Significance: direct difference B − s·A, no PSF matching",
            detail="S is the pixel difference over its noise with a 5 % systematic floor; a PSF "
            "difference between the frames leaves residuals at bright stars",
        ),
        models.Check(
            code="PAIR_PSF_UNAVAILABLE",
            severity="info",
            message=f"No ePSF for {missing}",
            detail="A cutout of this frame carries no EPSF table, or it is no longer cached",
        ),
    ]


def _residual_check(
    residuals: list[Residual],
    matched: bool,
    registration_px: float,
    rescale: float,
    searched: float,
    blocked: bool,
) -> models.Check:
    noise = (
        "ZOGY S_corr: pixel variance of both frames through the matching kernels (source noise "
        f"included), registration noise {registration_px:.2f} px and 5 % of the PSF-matched flux"
        if matched
        else "pixel variance of both frames and 5 % of the local flux"
    )
    unknown = sum(r.kind == "unknown" for r in residuals)
    return models.Check(
        code="PAIR_RESIDUALS",
        severity="info",
        message="Residuals not searched: A and B do not compare"
        if blocked
        else f"{len(residuals)} residuals ≥ {RESIDUAL_SIGMA:g}σ, {unknown} need verification",
        detail=f"Noise model: {noise}, scaled ×{rescale:.2f} to the measured scatter. Searched "
        f"{searched:.0%} of the field: pixels without data in A or B and the "
        f"{MASK_MARGIN_PX} px around them are left out, as masked star cores and artefact rims "
        "leave residuals there. Residuals are candidates to inspect, not discoveries: known "
        "asteroids, moving or variable stars, PSF differences, saturation and artefacts explain "
        "most of them",
    )


def _check(check: Check, code: str) -> models.Check:
    severity = {"ok": "info", "info": "info", "warn": "warning", "fail": "blocker"}
    return models.Check(
        code=code, severity=severity[check.severity], message=check.title, detail=check.detail
    )


def _bodies_at(
    epochs: list[models.SmallBodyEpoch], frame: Frame
) -> list[tuple[models.SmallBody, float, float]] | None:
    """Known asteroids and comets bright enough for SPHEREx at the frame's time: the answered
    epoch nearest to it within SMALL_BODY_GAP_DAYS, moved along JPL's rates. None when no epoch
    was answered that close."""
    answered = [
        e for e in epochs if e.error is None and abs(e.mjd - frame.mjd) <= SMALL_BODY_GAP_DAYS
    ]
    if not answered:
        return None
    epoch = min(answered, key=lambda e: abs(e.mjd - frame.mjd))
    hours = (frame.mjd - epoch.mjd) * 24
    return [
        (
            body,
            (body.ra + body.ra_rate * hours / 3600 / math.cos(math.radians(body.dec))) % 360,
            body.dec + body.dec_rate * hours / 3600,
        )
        for body in epoch.bodies
        if body.vmag is None or body.vmag <= SSO_VMAG_LIMIT
    ]


def _explain(
    x: float,
    y: float,
    s: float,
    grid: Grid,
    manifest: FrameManifest,
    a: Frame,
    b: Frame,
    bodies: list[list[tuple[models.SmallBody, float, float]] | None],
    checked: bool,
) -> Residual:
    """The residual at grid pixel (x, y) with its most likely explanation, as
    analysis._vet_residuals ranks them: a known asteroid at the time of the brighter frame, a
    bright star whose zone it lies in (unless a brighter catalogue source sits on it), a
    catalogue source detected in A or B, else nothing known."""
    pix = manifest.pixel_scale_arcsec
    ra, dec = (float(v) for v in grid.wcs.pixel_to_world_values(x, y))
    shown = (x, grid.npix - 1 - y)
    brighter, near_bodies = ("B", bodies[1]) if s > 0 else ("A", bodies[0])
    sources = [*a.sources, *b.sources]

    def distance(source: DetectedSource) -> float:
        return math.hypot(source.x - shown[0], source.y - shown[1])

    body, separation = None, math.inf
    for candidate, body_ra, body_dec in near_bodies or []:
        east = ((ra - body_ra + 180) % 360 - 180) * math.cos(math.radians(dec))
        sep = 3600 * math.hypot(east, dec - body_dec)
        if sep <= MATCH_RADIUS_PX * pix + SSO_PARALLAX_ARCSEC and sep < separation:
            body, separation = candidate, sep
    on_it = [
        src
        for src in sources
        if src.match in ("gaia", "allwise") and distance(src) <= MATCH_RADIUS_PX
    ]
    best = min(on_it, key=lambda src: src.catalog_mag or 99.0, default=None)
    zones = [(src, mag) for src in sources if (mag := _bright_mag(src)) is not None]
    bright, bright_mag = min(
        ((src, mag) for src, mag in zones if distance(src) <= bright_radius_px(mag)),
        key=lambda item: distance(item[0]),
        default=(None, None),
    )
    if body is not None:
        speed = math.hypot(body.ra_rate, body.dec_rate)
        vmag = f"V {body.vmag:.1f}, " if body.vmag is not None else ""
        kind, known = "asteroid", body.name
        text = (
            f"Known asteroid or comet {body.name} ({vmag}{speed:.0f}″/h) predicted "
            f"{separation:.0f}″ away at {brighter}'s time (JPL SBIdent): it explains the change"
        )
    elif bright is not None and (best is None or (best.catalog_mag or 99.0) > bright_mag):
        kind, known = "bright_star", bright.catalog_id
        name = bright.catalog_id or "a saturated star"
        text = (
            f"{distance(bright):.1f} px from bright star {name}"
            + (f" (G {bright.catalog_mag:.1f})" if bright.catalog_band == "G" else "")
            + ": PSF wings, saturation or bleeding, rarely a real change"
        )
    elif best is not None:
        kind, known = "known_star", best.catalog_id
        band = (
            f", {best.catalog_band} {best.catalog_mag:.1f}" if best.catalog_mag is not None else ""
        )
        moved = _moved_px(best.catalog_id, a.sources, b.sources)
        text = (
            f"At catalogue source {best.catalog_id}{band}"
            + (
                f", which moved {moved:.1f} px between A and B (known proper motion)"
                if moved
                else ""
            )
            + ": variability, motion or a PSF or wavelength effect – needs checking"
        )
    else:
        kind, known = "unknown", None
        text = (
            "No known asteroid, bright star or catalogue source here: an artefact, a moving "
            "object, a transient or a variable – needs verification"
            + ("" if checked else ". Known asteroids were not checked at A's and B's times")
        )
    return Residual(
        x=round(shown[0], 2),
        y=round(shown[1], 2),
        ra=round(ra % 360, 6),
        dec=round(dec, 6),
        significance=round(s, 2),
        kind=kind,
        known=known,
        explanation=f"Brighter in {brighter}. {text}.",
    )


def _bright_mag(source: DetectedSource) -> float | None:
    """The magnitude that sets a bright star's zone: its Gaia G below BRIGHT_G, or SATURATED_G
    for a saturated core; None for any other source."""
    g = source.catalog_mag if source.catalog_band == "G" else None
    if source.saturated:
        return min(g, SATURATED_G) if g is not None else SATURATED_G
    return g if g is not None and g < BRIGHT_G else None


def _moved_px(
    catalog_id: str | None, sources_a: list[DetectedSource], sources_b: list[DetectedSource]
) -> float | None:
    """How far the catalogue source detected in A and in B moved between them, from MOVED_PX."""
    found = [[s for s in frame if s.catalog_id == catalog_id] for frame in (sources_a, sources_b)]
    if catalog_id is None or not all(found):
        return None
    moved = math.hypot(found[1][0].x - found[0][0].x, found[1][0].y - found[0][0].y)
    return moved if moved >= MOVED_PX else None
