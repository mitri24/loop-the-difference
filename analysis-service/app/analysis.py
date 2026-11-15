"""Science pipeline: blink sequences, difference images, residual vetting, spectra.

Pixel coordinates exposed to the frontend (``target_px``, residual ``x``/``y``) are
DISPLAY coordinates: origin at the top-left of the PNG, north up, east left.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import statistics
import warnings
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

import httpx
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from photutils.aperture import CircularAnnulus, CircularAperture
from photutils.centroids import centroid_com, centroid_sources
from photutils.detection import find_peaks
from scipy import ndimage

from . import imaging, psf
from .astrometry import angular_sep_arcsec, mjd_to_iso, mjd_to_jyear, propagate
from .catalogs import gaia_cone, sbident_field, wise_cone
from .comparability import compare_frames
from .config import settings
from .cutouts import DEGRADED_FLAGS, HARD_FLAGS, Cutout, CutoutError, fetch_cutout, load_cutout
from .irsa import find_observations, search_checks
from .schemas import (
    CatalogSource,
    Check,
    DifferenceResult,
    Frame,
    GridInfo,
    Observation,
    Residual,
    SequenceRequest,
    SequenceResult,
    SolarSystemMarker,
    SolarSystemObject,
    SpectrumPoint,
    SpectrumResult,
    Target,
)
from .spectral import BANDS
from .validation import parse_band, parse_dec, parse_fov, parse_ra

log = logging.getLogger(__name__)

Progress = Callable[[float, str], None]
# Epoch used to centre archive searches: "now", so a fast-moving target stays inside the
# search radius as SPHEREx keeps observing for years (data start in 2025.3).
SEARCH_EPOCH_JYEAR = round(float(Time.now().jyear), 2)
APERTURE_PX = 2.0
ANNULUS_PX = (4.0, 7.0)
RESIDUAL_SIGMA = 5.0
SSO_PARALLAX_ARCSEC = 10.0
# Fainter known objects are below SPHEREx single-visit sensitivity: never an explanation.
SSO_VMAG_LIMIT = 21.0
# Fractional systematic error added in quadrature in the significance map (QUALITY.md).
SYSTEMATIC_FRACTION = 0.05
MATCH_RADIUS_PX = 1.5


# ------------------------------------------------------------------------- storage --
@dataclass
class StoredFrame:
    meta: Frame
    image: np.ndarray
    variance: np.ndarray
    hard_mask: np.ndarray
    flags: np.ndarray
    grid: imaging.Grid
    target: Target
    flag_names: dict[int, str]
    psf: np.ndarray | None = None  # PSF stamp on the grid (imaging.grid_psf), None without ePSF


class _LRU(OrderedDict):
    def __init__(self, cap: int) -> None:
        super().__init__()
        self.cap = cap

    def put(self, key: str, value: object) -> None:
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.cap:
            self.popitem(last=False)


FRAMES: _LRU = _LRU(3000)


def _frame_id(*parts: object) -> str:
    return hashlib.sha1(json.dumps(parts, default=str).encode()).hexdigest()[:20]


def _save_frame_files(fid: str, img: np.ndarray, grid: imaging.Grid, png: bytes) -> None:
    settings.frame_cache.mkdir(parents=True, exist_ok=True)
    (settings.frame_cache / f"{fid}.png").write_bytes(png)
    hdr = grid.wcs.to_header()
    hdr["BUNIT"] = "MJy/sr"
    hdr["COMMENT"] = "SPHEREx data (NASA/IPAC IRSA), background-subtracted, aligned grid"
    fits.PrimaryHDU(data=img.astype(np.float32), header=hdr).writeto(
        settings.frame_cache / f"{fid}.fits", overwrite=True
    )


# ------------------------------------------------------------------------- targets --
def target_from_request(req: SequenceRequest) -> Target:
    return Target(
        name=req.name,
        ra=parse_ra(req.ra),
        dec=parse_dec(req.dec),
        epoch_jyear=req.target_epoch_jyear,
        pm_ra_mas_yr=req.pm_ra_mas_yr,
        pm_dec_mas_yr=req.pm_dec_mas_yr,
        source="request",
    )


def target_at(t: Target, jyear: float) -> tuple[float, float]:
    return propagate(t.ra, t.dec, t.pm_ra_mas_yr, t.pm_dec_mas_yr, t.epoch_jyear, jyear)


def to_display(grid: imaging.Grid, x: float, y: float) -> tuple[float, float]:
    return float(x), float(grid.npix - 1 - y)


# ---------------------------------------------------------------------- selection --
def match_tolerance(lam: float, band: str) -> float:
    return settings.wavelength_match_fraction * lam / BANDS[band].resolving_power


def choose_matched(
    obs: list[Observation], band: str, reference: float | None
) -> tuple[float | None, list[Observation]]:
    """Pick, per visit, the exposure closest to one reference wavelength.

    Without a user reference we try every observed wavelength and keep the one that
    is matched in the most visits (ties: smallest mean |Δλ|).
    """
    usable = [o for o in obs if o.lambda_est_um is not None]
    if not usable:
        return None, []
    candidates = [reference] if reference else sorted({o.lambda_est_um for o in usable})

    def pick(lam: float) -> list[Observation]:
        tol = match_tolerance(lam, band)
        best: dict[int, Observation] = {}
        for o in usable:
            d = abs(o.lambda_est_um - lam)  # type: ignore[operator]
            if d <= tol and (o.visit not in best or d < abs(best[o.visit].lambda_est_um - lam)):
                best[o.visit] = o
        return sorted(best.values(), key=lambda o: o.mjd)

    scored = []
    for lam in candidates:
        sel = pick(lam)
        mean_d = statistics.fmean(abs(o.lambda_est_um - lam) for o in sel) if sel else 1e9
        scored.append((len(sel), -mean_d, lam, sel))
    scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
    return scored[0][2], scored[0][3]


def subsample(items: list, n: int) -> list:
    if len(items) <= n:
        return items
    idx = np.unique(np.linspace(0, len(items) - 1, n).round().astype(int))
    return [items[i] for i in idx]


# ------------------------------------------------------------------------ download --
async def download_all(
    obs: list[Observation],
    ra: float,
    dec: float,
    size_deg: float,
    progress: Progress,
    lo: float,
    hi: float,
) -> tuple[list[tuple[Observation, Cutout]], list[dict[str, str]]]:
    sem = asyncio.Semaphore(settings.max_concurrent_downloads)
    done = 0
    ok: list[tuple[Observation, Cutout]] = []
    failed: list[dict[str, str]] = []

    async with httpx.AsyncClient(follow_redirects=True) as client:

        async def one(o: Observation) -> None:
            nonlocal done
            try:
                path = await fetch_cutout(client, sem, o.access_url, ra, dec, size_deg)
                cut = await asyncio.to_thread(load_cutout, path)
                ok.append((o, cut))
            except (CutoutError, OSError, ValueError, KeyError) as exc:
                failed.append({"obs_id": o.obs_id, "band": o.band, "error": str(exc)[:200]})
            done += 1
            progress(lo + (hi - lo) * done / max(1, len(obs)), f"Cutouts {done}/{len(obs)}")

        await asyncio.gather(*(one(o) for o in obs))
    ok.sort(key=lambda p: p[0].mjd)
    return ok, failed


# ------------------------------------------------------------------------ sequence --
@dataclass
class _Single:
    obs: Observation
    cut: Cutout
    aligned: imaging.Aligned
    lam: float
    bw: float
    flags_at_target: list[str]
    target_px: tuple[float, float]
    psf: np.ndarray | None


def _measure_single(o: Observation, cut: Cutout, grid: imaging.Grid, t: Target) -> _Single:
    aligned = imaging.align(cut, grid)
    ra_t, dec_t = target_at(t, mjd_to_jyear(cut.mjd))
    cx, cy = cut.wcs.world_to_pixel_values(ra_t, dec_t)
    lam, bw = cut.wavelength_at(float(cx), float(cy))
    flags = cut.flags_in(float(cx), float(cy), APERTURE_PX)
    gx, gy = grid.wcs.world_to_pixel_values(ra_t, dec_t)
    stamp = imaging.grid_psf(cut, grid)
    return _Single(o, cut, aligned, lam, bw, flags, to_display(grid, gx, gy), stamp)


async def run_sequence(req: SequenceRequest, progress: Progress) -> SequenceResult:
    t = target_from_request(req)
    band = parse_band(req.band)
    fov = parse_fov(req.fov_arcmin)
    progress(0.02, "Searching IRSA for SPHEREx observations")
    ra_s, dec_s = target_at(t, SEARCH_EPOCH_JYEAR)
    all_obs, visits, checks, _ = await find_observations(ra_s, dec_s, fov / 60)
    # The archive-search checks are already shown by /api/observations; keep only blockers.
    checks += [c for c in search_checks(all_obs, visits) if c.severity == "fail"]
    obs = [o for o in all_obs if o.band == band]
    visit_label = {v.index: v.label for v in visits}
    if len(obs) < 1:
        checks.append(
            Check(
                code="no_band_data",
                severity="fail",
                title=f"No {band} observation",
                detail="Try another band; the per-band coverage is listed in the table.",
            )
        )
        grid = imaging.make_grid(ra_s, dec_s, fov)
        return SequenceResult(
            grid=_grid_info(grid), band=band, mode=req.mode, frames=[], checks=checks, failed=[]
        )

    # Centre the grid on the target at the median epoch of this band's data.
    mid_j = mjd_to_jyear(statistics.median(o.mjd for o in obs))
    ra_c, dec_c = target_at(t, mid_j)
    grid = imaging.make_grid(ra_c, dec_c, fov)

    if req.mode == "matched":
        lam_ref, selected = choose_matched(obs, band, req.reference_lambda_um)
        n_vis = len({o.visit for o in obs})
        checks.append(
            Check(
                code="matched_selection",
                severity="ok" if len(selected) >= 2 else "fail",
                title=f"Matched λ = {lam_ref:.3f} µm in {len(selected)}/{n_vis} visits"
                if lam_ref
                else "No wavelength estimate available",
                detail="One exposure per visit, within "
                f"{settings.wavelength_match_fraction:g} × λ/R of the reference wavelength.",
            )
        )
    elif req.mode == "all":
        selected = subsample(obs, settings.max_frames_per_job)
        checks.append(
            Check(
                code="all_frames",
                severity="info",
                title=f"{len(selected)} individual exposures in time order",
                detail="Each exposure sees the target at a different LVF wavelength: "
                "brightness changes within a visit are mostly spectral, not temporal.",
            )
        )
    else:  # stack
        per_visit: dict[int, list[Observation]] = {}
        for o in obs:
            per_visit.setdefault(o.visit, []).append(o)
        cap = max(4, settings.max_frames_per_job // max(1, len(per_visit)))
        selected = [o for group in per_visit.values() for o in subsample(group, cap)]

    size = imaging.cutout_size_deg(fov)
    pairs, failed = await download_all(selected, ra_c, dec_c, size, progress, 0.05, 0.85)
    progress(0.87, "Aligning frames on a common WCS grid")
    singles = await asyncio.to_thread(lambda: [_measure_single(o, c, grid, t) for o, c in pairs])
    singles = [s for s in singles if s.aligned.coverage > 0.05]

    frames: list[StoredFrame] = []
    if req.mode == "stack":
        groups: dict[int, list[_Single]] = {}
        for s in singles:
            groups.setdefault(s.obs.visit, []).append(s)
        for v, group in sorted(groups.items()):
            frames.append(_stack_frame(group, grid, t, band, v, visit_label[v]))
    else:
        frames = [_single_frame(s, grid, t, band, visit_label[s.obs.visit]) for s in singles]

    if req.mode == "matched" and len(frames) >= 2:
        lams = [f.meta.lambda_um for f in frames]
        spread = max(lams) - min(lams)
        tol = 2 * match_tolerance(statistics.fmean(lams), band)
        checks.append(
            Check(
                code="matched_verified",
                severity="ok" if spread <= tol else "warn",
                title=f"Exact wavelengths after download span {spread * 1000:.1f} nm",
                detail="Recomputed from each cutout's WCS-WAVE table at the target pixel.",
            )
        )

    _render_frames(frames, req.stretch)
    if len(frames) >= 2:
        checks.append(_motion_check(t, frames, grid))
    if failed:
        checks.append(
            Check(
                code="download_failures",
                severity="warn",
                title=f"{len(failed)} cutout(s) could not be retrieved",
                detail="IRSA did not return them; the sequence uses the others.",
            )
        )
    progress(1.0, "Done")
    return SequenceResult(
        grid=_grid_info(grid),
        band=band,
        mode=req.mode,
        frames=[f.meta for f in frames],
        checks=checks,
        failed=failed,
    )


def _grid_info(grid: imaging.Grid) -> GridInfo:
    return GridInfo(
        ra=grid.ra,
        dec=grid.dec,
        npix=grid.npix,
        pixel_arcsec=grid.pixel_arcsec,
        fov_arcmin=grid.fov_arcmin,
        wcs_header=grid.header_dict(),
    )


def _base_meta(fid: str, **kw: object) -> dict:
    return {
        "id": fid,
        "png_url": f"/api/frames/{fid}.png",
        "fits_url": f"/api/frames/{fid}.fits",
        **kw,
    }


def _single_frame(s: _Single, grid: imaging.Grid, t: Target, band: str, label: str) -> StoredFrame:
    a = s.aligned
    fid = _frame_id("single", s.obs.obs_publisher_did, grid.ra, grid.dec, grid.npix)
    meta = Frame(
        **_base_meta(
            fid,
            kind="single",
            band=band,
            visit=s.obs.visit,
            visit_label=label,
            mjd=s.cut.mjd,
            mjd_start=float(s.cut.header.get("MJD-BEG", s.cut.mjd)),
            mjd_end=float(s.cut.header.get("MJD-END", s.cut.mjd)),
            date_utc=mjd_to_iso(s.cut.mjd),
            lambda_um=s.lam,
            lambda_min_um=s.lam,
            lambda_max_um=s.lam,
            bandwidth_um=s.bw,
            n_exposures=1,
            obs_ids=[s.obs.obs_id],
            source_urls=[s.obs.access_url],
            collections=[s.obs.collection],
            flags_at_target=s.flags_at_target,
            hard_flag_fraction=float(a.hard_mask.mean()),
            coverage=a.coverage,
            psf_fwhm_arcsec=_float_or_none(s.cut.header.get("PSF_FWHM")),
            background_mjy_sr=a.background,
            noise_mjy_sr=_finite(a.noise),
            target_px=s.target_px,
        )
    )
    return StoredFrame(
        meta, a.image, a.variance, a.hard_mask, a.flags, grid, t, s.cut.flag_names, s.psf
    )


def _stack_frame(
    group: list[_Single], grid: imaging.Grid, t: Target, band: str, visit: int, label: str
) -> StoredFrame:
    img, var, coverage = imaging.stack([s.aligned for s in group])
    w = np.array([1.0 / max(s.aligned.noise, 1e-9) ** 2 for s in group])
    lams = np.array([s.lam for s in group])
    mjds = np.array([s.cut.mjd for s in group])
    lam_eff = float((w * lams).sum() / w.sum())
    mjd = float(mjds.mean())
    flags_union = sorted({f for s in group for f in s.flags_at_target})
    hard = ~np.isfinite(img)
    flag_or = np.bitwise_or.reduce(np.stack([s.aligned.flags for s in group]), axis=0)
    _, _, noise = (
        sigma_clipped_stats(img[np.isfinite(img)])
        if np.isfinite(img).any()
        else (0, 0, float("nan"))
    )
    ra_t, dec_t = target_at(t, mjd_to_jyear(mjd))
    gx, gy = grid.wcs.world_to_pixel_values(ra_t, dec_t)
    fwhms = [v for s in group if (v := _float_or_none(s.cut.header.get("PSF_FWHM")))]
    # A point source in the stack has the weighted mean PSF of its exposures.
    stamps = [s.psf for s in group]
    stack_psf = None if any(p is None for p in stamps) else np.average(stamps, axis=0, weights=w)
    fid = _frame_id(
        "stack", sorted(s.obs.obs_publisher_did for s in group), grid.ra, grid.dec, grid.npix
    )
    meta = Frame(
        **_base_meta(
            fid,
            kind="stack",
            band=band,
            visit=visit,
            visit_label=label,
            mjd=mjd,
            mjd_start=float(mjds.min()),
            mjd_end=float(mjds.max()),
            date_utc=mjd_to_iso(mjd),
            lambda_um=lam_eff,
            lambda_min_um=float(lams.min()),
            lambda_max_um=float(lams.max()),
            bandwidth_um=None,
            n_exposures=len(group),
            obs_ids=[s.obs.obs_id for s in group],
            source_urls=[s.obs.access_url for s in group],
            collections=sorted({s.obs.collection for s in group}),
            flags_at_target=flags_union,
            hard_flag_fraction=float(hard.mean()),
            coverage=coverage,
            psf_fwhm_arcsec=float(np.median(fwhms)) if fwhms else None,
            background_mjy_sr=float(np.mean([s.aligned.background for s in group])),
            noise_mjy_sr=_finite(float(noise)),
            target_px=to_display(grid, gx, gy),
        )
    )
    return StoredFrame(meta, img, var, hard, flag_or, grid, t, group[0].cut.flag_names, stack_psf)


def _render_frames(frames: list[StoredFrame], stretch: str) -> None:
    limits = [imaging.display_limits(f.image, f.meta.noise_mjy_sr) for f in frames]
    if stretch == "shared" and limits:
        shared = (min(lo for lo, _ in limits), float(np.median([hi for _, hi in limits])))
        limits = [shared] * len(frames)
    for f, (lo, hi) in zip(frames, limits, strict=True):
        png = imaging.render_png(f.image, lo, hi)
        _save_frame_files(f.meta.id, f.image, f.grid, png)
        FRAMES.put(f.meta.id, f)


def _motion_check(t: Target, frames: list[StoredFrame], grid: imaging.Grid) -> Check:
    first, last = frames[0].meta, frames[-1].meta
    dx = last.target_px[0] - first.target_px[0]
    dy = last.target_px[1] - first.target_px[1]
    shift = math.hypot(dx, dy)
    years = (last.mjd - first.mjd) / 365.25
    if not (t.pm_ra_mas_yr or t.pm_dec_mas_yr):
        return Check(
            code="target_motion",
            severity="info",
            title="No proper motion supplied",
            detail="The crosshair stays fixed. Resolve the target by name to "
            "propagate its catalogue proper motion.",
        )
    return Check(
        code="target_motion",
        severity="info",
        title=f'Expected target shift: {shift:.2f} px ({shift * grid.pixel_arcsec:.1f}") '
        f"over {years:.2f} yr",
        detail="From the catalogue proper motion. The crosshair follows the predicted "
        "position in each frame; a source that tracks it confirms the known motion.",
    )


def _float_or_none(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _finite(v: float) -> float:
    return v if math.isfinite(v) else 0.0


# ---------------------------------------------------------------------- difference --
async def difference(frame_a: str, frame_b: str, force: bool) -> DifferenceResult:
    a: StoredFrame | None = FRAMES.get(frame_a)
    b: StoredFrame | None = FRAMES.get(frame_b)
    if a is None or b is None:
        raise KeyError("Frame not found (expired from memory). Rebuild the sequence.")
    if a.grid != b.grid:
        raise ValueError("Frames are on different grids; rebuild them in one sequence.")
    comparable, checks = compare_frames(a.meta, b.meta)
    did = _frame_id("diff", frame_a, frame_b)
    dt = b.meta.mjd - a.meta.mjd
    dlam = b.meta.lambda_um - a.meta.lambda_um
    if not comparable and not force:
        return DifferenceResult(
            id=did,
            frame_a=frame_a,
            frame_b=frame_b,
            comparable=False,
            png_url="",
            significance_png_url="",
            checks=checks,
            residuals=[],
            delta_days=dt,
            delta_lambda_um=dlam,
        )
    if not comparable:
        checks.insert(
            0,
            Check(
                code="forced",
                severity="fail",
                title="Shown although NOT comparable",
                detail="For inspection only. Do not interpret residuals.",
            ),
        )
    b, reg_check, reg_error = register(a, b)
    checks.append(reg_check)
    matched = a.psf is not None and b.psf is not None
    checks += _method_checks(a, b, matched)
    scale, n_scale = photometric_scale(a, b)
    checks.append(
        Check(
            code="photometric_scale",
            severity="ok" if n_scale >= 20 and 0.67 < scale < 1.5 else "warn",
            title=f"B scaled ×{scale:.3f} to match A",
            detail=f"Robust flux ratio from {n_scale} high-S/N pixels (field stars) removes "
            "calibration/wavelength offsets before subtraction."
            if n_scale >= 20
            else "Too few bright pixels to fit a scale reliably; ×1 assumed.",
        )
    )
    diff = a.image - scale * b.image
    bad = a.hard_mask | b.hard_mask
    if matched:
        sig = psf.zogy(
            np.where(bad, 0.0, np.nan_to_num(a.image)),
            np.where(bad, 0.0, np.nan_to_num(b.image)),
            _filled(a.variance, bad),
            _filled(b.variance, bad),
            a.psf,
            b.psf,
            flux_ratio=scale,
            sigma_ast=reg_error,
            floor=SYSTEMATIC_FRACTION,
        )
    else:
        with np.errstate(invalid="ignore", divide="ignore"):
            # Noise model: photon/read variance of both frames PLUS a systematic floor
            # proportional to the local brightness (PSF mismatch between stacks and single
            # exposures, flux calibration). Without it every bright star is a ">5σ" residual.
            local = np.maximum(np.abs(a.image), np.abs(scale * b.image))
            sig = diff / np.sqrt(
                a.variance + scale**2 * b.variance + (SYSTEMATIC_FRACTION * local) ** 2
            )
    bad = bad | ~np.isfinite(sig)
    diff = np.where(bad, np.nan, diff)
    sig = np.where(bad, np.nan, sig)
    # Empirical renormalisation: pipeline variances ignore the pixel covariance created
    # by resampling and stacking. Scale S so its robust std is 1 (never below 1).
    noise_rescale = 1.0
    if np.isfinite(sig).sum() > 50:
        _, _, s_std = sigma_clipped_stats(sig[np.isfinite(sig)], sigma=3.0)
        noise_rescale = max(1.0, float(s_std))
        sig = sig / noise_rescale
    finite = diff[np.isfinite(diff)]
    lim = 5 * float(np.std(finite)) if finite.size else 1.0
    if finite.size:
        _, _, std = sigma_clipped_stats(finite)
        lim = 5 * float(std) or lim
    settings.frame_cache.mkdir(parents=True, exist_ok=True)
    (settings.frame_cache / f"{did}.png").write_bytes(
        imaging.render_png(diff, -lim, lim, diverging=True)
    )
    (settings.frame_cache / f"{did}_sig.png").write_bytes(
        imaging.render_png(sig, -7, 7, diverging=True)
    )
    residuals: list[Residual] = []
    peaks: list[tuple[float, float, float]] = []
    refs = References([], [], None, None)
    if comparable:
        peaks = _find_residual_peaks(sig, bad)
        if peaks:
            refs, ref_checks = await _fetch_static_references(a.grid)
            checks += ref_checks
        residuals = _vet_residuals(peaks, a, b, refs)
    n_unknown = sum(1 for r in residuals if r.known_source is None)
    noise_model = (
        "ZOGY S_corr: pixel variance of both frames through the matching kernels "
        f"(source noise included), registration noise {reg_error:.2f} px and 5% of the "
        "PSF-matched flux (the resampled PSF differs from star to star with the sub-pixel "
        "position; ePSF model and calibration errors)"
        if matched
        else "pixel variance + 5% of the local flux (PSF/calibration systematics)"
    )
    checks.append(
        Check(
            code="residuals",
            severity="info" if residuals else "ok",
            title=f"{len(residuals)} residual(s) above {RESIDUAL_SIGMA:g}σ, "
            f"{n_unknown} unexplained",
            detail=f"Noise model: {noise_model}, rescaled ×{noise_rescale:.2f} to the empirical "
            "scatter. Residuals are candidates to inspect, not discoveries: known proper-motion "
            "stars, PSF differences, saturation and artefacts explain most of them.",
        )
    )
    result = DifferenceResult(
        id=did,
        frame_a=frame_a,
        frame_b=frame_b,
        comparable=comparable,
        png_url=f"/api/frames/{did}.png",
        significance_png_url=f"/api/frames/{did}_sig.png",
        checks=checks,
        residuals=residuals,
        delta_days=dt,
        delta_lambda_um=dlam,
        significance_method="zogy" if matched else "direct",
    )
    DIFFS.put(did, DiffContext(a, b, peaks, refs, result))
    return result


def _method_checks(a: StoredFrame, b: StoredFrame, matched: bool) -> list[Check]:
    if matched:
        return [
            Check(
                code="difference_method",
                severity="ok",
                title="Significance: PSF-matched difference (ZOGY)",
                detail="Zackay, Ofek & Gal-Yam 2016 (ApJ 830, 27): A and B are matched with "
                "their SPHEREx ePSFs (the zone at the target, resampled onto the grid like the "
                "frames; a stack uses the weighted mean of its exposures). That removes most of "
                "what a PSF difference leaves at stars, not all: the resampled PSF changes from "
                "star to star with the sub-pixel position, which the 5% floor in S_corr absorbs, "
                "so very bright stars can still leave residuals. S is the corrected score S_corr.",
            )
        ]
    missing = " and ".join(n for n, f in (("A", a), ("B", b)) if f.psf is None)
    return [
        Check(
            code="difference_method",
            severity="info",
            title="Significance: direct difference A − sB, no PSF matching",
            detail="S is the pixel difference over its noise with a 5% systematic floor; a PSF "
            "difference between the frames leaves residuals at bright stars.",
        ),
        Check(
            code="psf_unavailable",
            severity="info",
            title=f"No ePSF for {missing}",
            detail="The archive sent no usable EPSF extension with the cutout, or the frame was "
            "built before ePSFs were kept: rebuilding the sequence fetches them again.",
        ),
    ]


def _filled(variance: np.ndarray, bad: np.ndarray) -> np.ndarray:
    """Variance with masked or missing pixels set to the median of the rest."""
    good = ~bad & np.isfinite(variance)
    return np.where(good, variance, np.median(variance[good]) if good.any() else 1.0)


@dataclass
class References:
    """Reference sources used to explain residuals. ``wise`` is CatWISE2020, or AllWISE when
    IRSA did not deliver it. ``sso_*`` is None until the (slow) JPL SBIdent check has run for
    epoch A / B."""

    gaia: list[CatalogSource]
    wise: list[CatalogSource]
    sso_a: list[SolarSystemObject] | None
    sso_b: list[SolarSystemObject] | None


@dataclass
class DiffContext:
    a: StoredFrame
    b: StoredFrame
    peaks: list[tuple[float, float, float]]
    refs: References
    result: DifferenceResult


DIFFS: _LRU = _LRU(200)


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


async def _fetch_static_references(grid: imaging.Grid) -> tuple[References, list[Check]]:
    """Gaia DR3 and CatWISE2020 (else AllWISE) around the field, in parallel. A failing service
    degrades the vetting (with a visible warning) instead of failing the difference."""
    radius = grid.fov_arcmin / 60 * 0.75
    checks: list[Check] = []
    async with httpx.AsyncClient(follow_redirects=True) as client:
        gaia, wise = await asyncio.gather(
            gaia_cone(grid.ra, grid.dec, radius, client),
            wise_cone(grid.ra, grid.dec, radius, client),
            return_exceptions=True,
        )
    if not isinstance(wise, BaseException):
        wise, checks = wise
    for name, res in (("Gaia DR3", gaia), ("WISE", wise)):
        if isinstance(res, BaseException):
            checks.append(
                Check(
                    code=f"{name.split()[0].lower()}_unavailable",
                    severity="warn",
                    title=f"{name} cross-match unavailable",
                    detail=f"Residuals vetted without {name} ({type(res).__name__}).",
                )
            )
    return References(
        gaia=[] if isinstance(gaia, BaseException) else gaia,
        wise=[] if isinstance(wise, BaseException) else wise,
        sso_a=None,
        sso_b=None,
    ), checks


def _match_sso(
    objs: list[SolarSystemObject] | None, ra: float, dec: float, frame: Frame, pix: float
) -> tuple[SolarSystemObject | None, float]:
    """Known asteroid/comet whose TRACK during the frame passes near (ra, dec).

    SBIdent gives the position at ``frame.mjd`` and the apparent rate; over the frame's
    time span [mjd_start, mjd_end] (days for a visit stack) the object sweeps a segment.
    We use the point-to-segment distance (tangent plane, arcsec), tolerance = 1.5 px +
    LEO parallax. Objects fainter than SSO_VMAG_LIMIT cannot be seen by SPHEREx and are
    ignored (they caused a false match in testing: QUALITY.md log 2026-11-14 #5)."""
    if not objs:
        return None, 1e9
    t0 = (frame.mjd_start - frame.mjd) * 24.0  # hours relative to the SBIdent epoch
    t1 = (frame.mjd_end - frame.mjd) * 24.0
    tol = MATCH_RADIUS_PX * pix + SSO_PARALLAX_ARCSEC
    cosd = math.cos(math.radians(dec))
    best, best_sep = None, 1e9
    for o in objs:
        if o.vmag is not None and o.vmag > SSO_VMAG_LIMIT:
            continue
        dra = ((ra - o.ra + 180.0) % 360.0 - 180.0) * cosd * 3600.0
        ddec = (dec - o.dec) * 3600.0
        vx, vy = o.ra_rate_arcsec_h, o.dec_rate_arcsec_h  # RA rate includes cos(dec)
        v2 = vx * vx + vy * vy
        t = 0.0 if v2 == 0 else min(t1, max(t0, (dra * vx + ddec * vy) / v2))
        sep = math.hypot(dra - vx * t, ddec - vy * t)
        if sep <= tol and sep < best_sep:
            best, best_sep = o, sep
    return best, best_sep


def _vet_residuals(
    peaks: list[tuple[float, float, float]], a: StoredFrame, b: StoredFrame, refs: References
) -> list[Residual]:
    grid = a.grid
    pix = grid.pixel_arcsec
    ja, jb = mjd_to_jyear(a.meta.mjd), mjd_to_jyear(b.meta.mjd)
    out: list[Residual] = []
    for x, y, s in peaks:
        ra, dec = (float(v) for v in grid.wcs.pixel_to_world_values(x, y))
        frame, epoch = (a.meta, ja) if s > 0 else (b.meta, jb)
        best, bright, bright_sep = _match_gaia(refs.gaia, ra, dec, epoch, pix)
        sso, sso_sep = _match_sso(refs.sso_a if s > 0 else refs.sso_b, ra, dec, frame, pix)
        flags = _flags_here(a.flags, b.flags, int(x), int(y), a.flag_names)
        sign = "brighter in A" if s > 0 else "brighter in B"
        known: str | None
        if sso is not None:
            vm = f"V={sso.vmag:.1f}, " if sso.vmag is not None else ""
            speed = math.hypot(sso.ra_rate_arcsec_h, sso.dec_rate_arcsec_h)
            kind, known = "solar_system", sso.name
            expl = (
                f'Known solar-system object {sso.name} ({vm}{speed:.0f}"/h) predicted '
                f'{sso_sep:.0f}" away at this epoch (JPL SBIdent, geocentric). '
                "Residual explained by a known asteroid/comet."
            )
        elif bright is not None and (best is None or (best.mag or 99) > (bright.mag or 99)):
            pm = math.hypot(bright.pm_ra_mas_yr or 0, bright.pm_dec_mas_yr or 0)
            moved_px = pm / 1000 * abs(jb - ja) / pix
            motion = (
                f" It moves {moved_px:.1f} px between the frames (known proper motion)."
                if moved_px >= 0.5
                else ""
            )
            kind, known = "bright_star", bright.id
            expl = (
                f"{bright_sep / pix:.1f} px from bright star {bright.id} "
                f"(G={bright.mag:.1f}): PSF wings, saturation or bleed residual.{motion}"
            )
        elif best is not None:
            pm = math.hypot(best.pm_ra_mas_yr or 0, best.pm_dec_mas_yr or 0)
            moved_px = pm / 1000 * abs(jb - ja) / pix
            mag = f"G={best.mag:.1f}" if best.mag is not None else ""
            known = best.id
            if moved_px >= 0.5:
                kind = "moving_star"
                expl = (
                    f'Known moving star {best.id} ({mag}, µ={pm / 1000:.2f}"/yr): '
                    f"expected to move {moved_px:.1f} px between the frames. "
                    "Residual explained by known proper motion."
                )
            else:
                kind = "known_source"
                expl = (
                    f"Coincides with known source {best.id} ({mag}). Flux change may be "
                    "real variability, or PSF/wavelength/saturation effects — needs "
                    "verification."
                )
        else:
            wise, wsep = _nearest(refs.wise, ra, dec, epoch, MATCH_RADIUS_PX * pix)
            if wise is not None:
                pm = math.hypot(wise.pm_ra_mas_yr or 0, wise.pm_dec_mas_yr or 0)
                moved_px = pm / 1000 * abs(jb - ja) / pix
                w1 = f"W1={wise.mag:.1f}" if wise.mag is not None else "W1 n/a"
                known = wise.id
                if moved_px >= 0.5:
                    kind = "moving_star"
                    expl = (
                        f'Known moving source {wise.id} ({w1}, µ={pm / 1000:.2f}"/yr), no Gaia '
                        f"DR3 counterpart: expected to move {moved_px:.1f} px between the "
                        "frames. Residual explained by known proper motion of a very red "
                        "object (e.g. a brown dwarf) — needs verification."
                    )
                else:
                    kind = "red_source"
                    expl = (
                        f'{wise.id} ({w1}) {wsep:.0f}" away at this epoch but no Gaia DR3 '
                        "counterpart: a very red object (brown dwarf, young star, dusty "
                        f"galaxy) that {wise.catalog} sees move less than half a pixel between "
                        "the frames — needs verification."
                    )
            else:
                kind, known = "unknown", None
                checked = (
                    "" if refs.sso_a is not None else " Run the known asteroid/comet check (JPL)."
                )
                expl = (
                    f"No Gaia DR3 or CatWISE2020/AllWISE source within "
                    f'{MATCH_RADIUS_PX * pix:.0f}" at this epoch. Inspect the individual frames: '
                    "artefact, solar-system object, transient or variable — needs verification."
                    + checked
                )
        if flags:
            expl += f" Pixel flags here: {', '.join(flags)}."
        dx, dy = to_display(grid, x, y)
        out.append(
            Residual(
                x=dx,
                y=dy,
                ra=ra,
                dec=dec,
                significance=s,
                explanation=f"{sign}. {expl}",
                known_source=known,
                kind=kind,
            )
        )
    out.sort(key=lambda r: -abs(r.significance))
    return out


def _nearest(
    sources: list[CatalogSource], ra: float, dec: float, epoch: float, radius_arcsec: float
) -> tuple[CatalogSource | None, float]:
    best, best_sep = None, 1e9
    for src in sources:
        # AllWISE motions are noisy but matter for fast brown dwarfs (8"/yr x 16 yr).
        sra, sdec = propagate(
            src.ra, src.dec, src.pm_ra_mas_yr, src.pm_dec_mas_yr, src.epoch_jyear, epoch
        )
        sep = angular_sep_arcsec(ra, dec, sra, sdec)
        if sep <= radius_arcsec and sep < best_sep:
            best, best_sep = src, sep
    return best, best_sep


async def run_solar_system_check(diff_id: str, progress: Progress) -> DifferenceResult:
    """Ask JPL SBIdent which known asteroids/comets were in the field at the epochs of
    A and B, then re-explain the residuals. Slow (1-3 min per epoch), hence a job."""
    ctx: DiffContext | None = DIFFS.get(diff_id)
    if ctx is None:
        raise KeyError("Difference not found (expired). Compare the frames again.")
    grid = ctx.a.grid
    half = grid.fov_arcmin / 120 * 1.2
    progress(0.05, "Asking JPL SBIdent for known asteroids and comets (1-3 min)")
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            sso_a, sso_b = await asyncio.gather(
                sbident_field(grid.ra, grid.dec, half, ctx.a.meta.mjd, client),
                sbident_field(grid.ra, grid.dec, half, ctx.b.meta.mjd, client),
            )
    except httpx.TimeoutException as exc:
        raise RuntimeError("JPL SBIdent did not answer in 5 minutes; try again later.") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"JPL SBIdent is unavailable ({type(exc).__name__}).") from exc
    progress(0.95, "Re-vetting residuals")
    ctx.refs = References(ctx.refs.gaia, ctx.refs.wise, sso_a, sso_b)
    residuals = _vet_residuals(ctx.peaks, ctx.a, ctx.b, ctx.refs)
    n_sso = sum(1 for r in residuals if r.kind == "solar_system")
    markers = []
    for label, frame, objs in (("A", ctx.a.meta, sso_a), ("B", ctx.b.meta, sso_b)):
        for o in objs:
            x, y = grid.wcs.world_to_pixel_values(o.ra, o.dec)
            if 0 <= x < grid.npix and 0 <= y < grid.npix:
                dx, dy = to_display(grid, float(x), float(y))
                markers.append(
                    SolarSystemMarker(
                        name=o.name, epoch=label, x=dx, y=dy, vmag=o.vmag, date_utc=frame.date_utc
                    )
                )
    check = Check(
        code="solar_system",
        severity="ok" if n_sso == 0 else "info",
        title=f"Known asteroids/comets: {len(sso_a)} at A, {len(sso_b)} at B; "
        f"{n_sso} residual(s) explained",
        detail="JPL Small-Body Identification API, geocentric positions (SPHEREx is in "
        'low-Earth orbit: up to ~10" parallax for main-belt objects).',
    )
    checks = [c for c in ctx.result.checks if c.code != "solar_system"] + [check]
    n_unknown = sum(1 for r in residuals if r.known_source is None)
    checks = [
        c.model_copy(
            update={
                "title": f"{len(residuals)} residual(s) above "
                f"{RESIDUAL_SIGMA:g}σ, {n_unknown} unexplained"
            }
        )
        if c.code == "residuals"
        else c
        for c in checks
    ]
    ctx.result = ctx.result.model_copy(
        update={"residuals": residuals, "checks": checks, "solar_system": markers}
    )
    progress(1.0, "Done")
    return ctx.result


BRIGHT_G = 12.0


def bright_radius_px(g_mag: float) -> float:
    """Zone of influence of a bright star (PSF wings, saturation, bleed) in pixels.
    Grows with brightness: G=12 → 2 px, G=10 → 5 px, G=8 → 8 px (capped at 12)."""
    return float(min(12.0, 2.0 + 1.5 * (BRIGHT_G - g_mag)))


def _match_gaia(
    gaia: list, ra: float, dec: float, epoch: float, pix: float
) -> tuple[object | None, object | None, float]:
    """Brightest Gaia source within MATCH_RADIUS_PX, and nearest bright (G<12) star
    within its zone of influence, both at ``epoch``. Brightness-aware: in crowded fields the
    nearest source is often a G~20 star that SPHEREx cannot even detect."""
    best, bright, bright_sep = None, None, 1e9
    for src in gaia:
        sra, sdec = propagate(
            src.ra, src.dec, src.pm_ra_mas_yr, src.pm_dec_mas_yr, src.epoch_jyear, epoch
        )
        sep = angular_sep_arcsec(ra, dec, sra, sdec)
        mag = src.mag if src.mag is not None else 99.0
        if sep <= MATCH_RADIUS_PX * pix and (best is None or mag < (best.mag or 99.0)):
            best = src
        if mag < BRIGHT_G and sep <= bright_radius_px(mag) * pix and sep < bright_sep:
            bright, bright_sep = src, sep
    return best, bright, bright_sep


REGISTRATION_MIN_STARS = 5
# Registration noise for ZOGY when too few stars measure it: 0.2 px (1.2″), a conservative guess
# for a WCS-only alignment. The term only lowers S next to bright sources, so overestimating it
# costs little sensitivity; underestimating it turns every star into a dipole residual.
UNMEASURED_REGISTRATION_PX = 0.2


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


def _flags_here(fa: np.ndarray, fb: np.ndarray, x: int, y: int, names: dict[int, str]) -> list[str]:
    v = int(fa[y, x]) | int(fb[y, x])
    return sorted(
        n for bit, n in names.items() if v & (1 << bit) and n not in ("SOURCE", "FULLSAMPLE")
    )


# ------------------------------------------------------------------------ spectrum --
def aperture_flux(
    cut: Cutout, ra: float, dec: float
) -> tuple[float, float, float, float, list[str], str, float | None] | None:
    """Aperture flux and error (mJy), wavelength, bandwidth, flags, quality, and the
    aperture correction to total flux (None without an ePSF)."""
    x, y = (float(v) for v in cut.wcs.world_to_pixel_values(ra, dec))
    ny, nx = cut.image.shape
    r_out = ANNULUS_PX[1]
    if not (r_out <= x < nx - r_out and r_out <= y < ny - r_out):
        return None
    hard = cut.mask(HARD_FLAGS)
    ann = CircularAnnulus((x, y), *ANNULUS_PX).to_mask(method="center")
    vals = ann.get_values(np.where(hard, np.nan, cut.image))
    vals = vals[np.isfinite(vals)]
    if vals.size < 10:
        return None
    _, bkg, bkg_std = sigma_clipped_stats(vals, sigma=3.0)
    ap = CircularAperture((x, y), APERTURE_PX)
    apm = ap.to_mask(method="exact")
    img_vals = apm.multiply(np.nan_to_num(cut.image))
    var_vals = apm.multiply(np.nan_to_num(cut.variance))
    hard_in = apm.multiply((hard | ~np.isfinite(cut.image)).astype(float))
    area = float(apm.data.sum())
    total = float(img_vals.sum()) - bkg * area
    var = float(var_vals.sum()) + area**2 * bkg_std**2 / vals.size
    omega = cut.pixel_solid_angle_sr
    to_mjy = omega * 1e9  # MJy/sr * sr -> MJy -> mJy
    flags = cut.flags_in(x, y, APERTURE_PX)
    if hard_in.sum() > 0:
        quality = "bad"
    elif set(flags) & DEGRADED_FLAGS:
        quality = "degraded"
    else:
        quality = "good"
    lam, bw = cut.wavelength_at(x, y)
    correction = None
    if cut.psf is not None:
        # Share of a point source in this aperture, at the target's sub-pixel position.
        point = psf.pixel_psf(cut.psf, x, y, cut.image.shape)
        correction = 1.0 / float(np.sum(apm.to_image(cut.image.shape) * point))
    return total * to_mjy, math.sqrt(max(var, 0.0)) * to_mjy, lam, bw, flags, quality, correction


async def run_spectrum(t: Target, max_frames: int, progress: Progress) -> SpectrumResult:
    progress(0.02, "Searching IRSA for SPHEREx observations")
    ra_s, dec_s = target_at(t, SEARCH_EPOCH_JYEAR)
    obs, visits, checks, _ = await find_observations(ra_s, dec_s, 2 / 60)
    checks += search_checks(obs, visits)
    ordered = sorted(obs, key=lambda o: (o.lambda_est_um or 0, o.mjd))
    selected = subsample(ordered, max_frames)
    if len(selected) < len(obs):
        checks.append(
            Check(
                code="spectrum_subsampled",
                severity="info",
                title=f"{len(selected)} of {len(obs)} exposures used",
                detail="Evenly spread in wavelength to bound download time; "
                "raise max_frames for a denser spectrum.",
            )
        )
    pairs, failed = await download_all(selected, ra_s, dec_s, 0.03, progress, 0.05, 0.92)
    progress(0.94, "Aperture photometry")
    measured = []
    for o, cut in pairs:
        ra_t, dec_t = target_at(t, mjd_to_jyear(cut.mjd))
        res = aperture_flux(cut, ra_t, dec_t)
        if res is None:
            failed.append({"obs_id": o.obs_id, "band": o.band, "error": "target too near edge"})
            continue
        measured.append((o, cut, res))
    # Corrected and uncorrected fluxes are not comparable: all points or none.
    factors = [res[6] for _, _, res in measured]
    corrected = bool(factors) and None not in factors
    points: list[SpectrumPoint] = []
    for o, cut, (flux, err, lam, bw, flags, quality, factor) in measured:
        if corrected:
            flux, err = flux * factor, err * factor
        points.append(
            SpectrumPoint(
                obs_id=o.obs_id,
                band=o.band,
                visit=o.visit,
                mjd=cut.mjd,
                lambda_um=lam,
                bandwidth_um=bw,
                flux_mjy=flux,
                flux_err_mjy=err,
                flags=flags,
                quality=quality,
                usable=quality != "bad",
                source_url=o.access_url,
            )
        )
    points.sort(key=lambda p: p.lambda_um)
    n_bad = sum(1 for p in points if p.quality == "bad")
    n_deg = sum(1 for p in points if p.quality == "degraded")
    if n_bad:
        checks.append(
            Check(
                code="spectrum_bad",
                severity="warn",
                title=f"{n_bad} point(s) with unusable pixels in the aperture",
                detail="Flags such as SUR_ERROR, NONFUNC or missing data. Drawn "
                "as crosses and excluded from interpretation.",
            )
        )
    if n_deg:
        checks.append(
            Check(
                code="spectrum_saturated",
                severity="warn",
                title=f"{n_deg} point(s) on a saturated target",
                detail="OVERFLOW/NONLINEAR: flux from the samples before "
                "saturation; expect larger, partly systematic errors. Drawn "
                "hollow.",
            )
        )
    if corrected:
        checks.append(
            Check(
                code="spectrum_method",
                severity="info",
                title=f'Aperture photometry, r = {APERTURE_PX * 6.15:.0f}", corrected to '
                "total flux",
                detail="Background from a sigma-clipped annulus. Each flux is divided by the "
                "share of the SPHEREx ePSF inside the aperture at the target's detector "
                f"position and sub-pixel phase: ×{min(factors):.3f}–{max(factors):.3f}. "
                'Total means within the ePSF model (±3.2 px, ±20"); wings beyond it are '
                "not included.",
            )
        )
    else:
        missing = sum(f is None for f in factors)
        checks.append(
            Check(
                code="spectrum_method",
                severity="info",
                title=f'Aperture photometry, r = {APERTURE_PX * 6.15:.0f}"',
                detail="Background from a sigma-clipped annulus. No aperture "
                "correction: absolute fluxes are underestimated by a smooth, "
                "wavelength-dependent factor; relative changes between visits at the "
                "same wavelength are meaningful."
                + (
                    f" {missing} exposure(s) came without an ePSF, so none is corrected."
                    if missing
                    else ""
                ),
            )
        )
    progress(1.0, "Done")
    return SpectrumResult(
        target_ra=ra_s,
        target_dec=dec_s,
        aperture_arcsec=APERTURE_PX * settings.native_pixel_arcsec,
        aperture_corrected=corrected,
        points=points,
        checks=checks,
        failed=failed,
    )
