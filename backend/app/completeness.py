"""Measured detection limit of the blink's A and B: artificial stars of known total flux are set
into a final frame and searched for with the frame's own source detection (sources.detect), an
injection-recovery test. The fluxes at which half of them, and nine in ten, are found again are the
frame's detection limits, measured on its real noise, masks and crowding instead of estimated.

The stars are drawn like real ones: with the SPHEREx ePSF of the frame's first exposure, on that
cutout's pixels, resampled onto the grid as frames.align resamples the data, so they carry the
detector's rotation and the smoothing of the interpolation at their own sub-pixel positions.
Without an ePSF they are Gaussians of the grid PSF's measured width (sources.FWHM_PX), integrated
over the pixels.
"""

import hashlib
import math
import warnings
from collections.abc import Callable
from itertools import combinations
from pathlib import Path
from typing import Literal, NamedTuple

import numpy as np
from astropy.stats import gaussian_fwhm_to_sigma, mad_std
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_area
from reproject import reproject_interp
from scipy import ndimage
from scipy.special import ndtr

from app.frames import (
    SPHEREX_PIXEL_SCALE_ARCSEC,
    WAVELENGTH_MATCH_FRACTION,
    Aligned,
    comparable_wavelengths,
)
from app.models import Check, Completeness, Frame
from app.psf import cutout_epsf, pixel_psf
from app.sources import (
    FWHM_PX,
    MAX_SOURCES,
    SKY_BOX_PX,
    THRESHOLD_SIGMA,
    Detection,
    _local_sky,
    detect,
)

# Total flux steps in units of the frame's 1σ point-source noise (the scatter of a PSF fit), from
# 3σ to 30σ around the 5σ detection threshold. Measured on synthetic and real frames, the share
# found rises from almost none to almost all between 5σ and 12σ (the detection's fixed Gaussian
# kernel, the sub-pixel position and confusion with faint stars cost S/N), so the steps are densest
# there; 30σ shows whether bright stars are all found, which masks and crowding can prevent.
LEVELS_SIGMA = (3.0, 4.0, 5.0, 6.0, 7.0, 8.5, 10.0, 12.0, 15.0, 30.0)
# Stars per step: the share found scatters by √(p(1 − p)/n), 0.11 at 50 % for 20 stars, which
# moves the interpolated 50 % flux by about 5 % (0.05 mag). 200 stars take two detection runs on
# the default 0.2° grid and about half a second per frame.
STARS_PER_LEVEL = 20
# A star counts as found when a detection lies this close to where it was set.
MATCH_RADIUS_PX = 1.5
# Stars of one run keep this far apart: neither enters the other's PSF fit or 11 px sky square.
SEPARATION_PX = 8
# ... and this far from the frame's own detections: never on an existing source.
CLEARANCE_PX = 4
# ... and this far from the grid edge, so their local sky square lies on the grid.
EDGE_PX = SKY_BOX_PX // 2
# Stamp half width: the resampled ePSF (±3.2 detector pixels) and a 1.6 px Gaussian lie within it.
_HALF_PX = 4
_UJY_PER_MJY_SR_DEG2 = 1e12 * (np.pi / 180) ** 2

# Stars on the grid: positions (grid pixels) and total fluxes (µJy) → their image in MJy/sr.
Draw = Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]


class Measured(NamedTuple):
    limit: Completeness
    # Per flux step (LEVELS_SIGMA): total flux (µJy), stars set and stars found again.
    fluxes: list[float]
    injected: list[int]
    found: list[int]


def measure_completeness(
    key: str, frames: list[Frame], stacks: list[Aligned], cutouts: list[Path], grid: WCS
) -> list[Check]:
    """Measure the detection limit of the frames the blink opens with as A and B (or of a lone
    frame) and set their `completeness`; returns the check that reports it.

    `stacks` are the frames' data and `cutouts` each frame's first cutout (for its ePSF). The seed
    comes from the job `key`: a rebuilt job sets the same stars."""
    seed = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big")
    measured = []
    for index in default_pair(frames) or range(len(frames)):
        frame, stack = frames[index], stacks[index]
        draw = _epsf_stars(cutouts[index], grid, stack.image.shape)
        result = measure(
            stack,
            draw or _gaussian_stars(grid, stack.image.shape),
            np.random.default_rng([seed, index]),
            psf="epsf" if draw else "gaussian",
        )
        if result is not None:
            frame.completeness = result.limit
            measured.append((frame, result))
    return completeness_checks(measured)


def default_pair(frames: list[Frame]) -> tuple[int, int] | None:
    """The frames the blink opens with as A and B, as defaultBlinkPair in frontend/src/blink.ts
    picks them (change both together): of two epochs at the same wavelength, the pair with the
    longest time baseline (then the epochs furthest apart), the earlier one as A; else the first
    frame of the earliest and of the latest epoch (one epoch: the last frame). None below two."""
    best, span, apart = None, -1.0, -1
    for i, j in combinations(range(len(frames)), 2):
        a, b = (i, j) if frames[i].mjd <= frames[j].mjd else (j, i)
        wave_a, wave_b = frames[a].wavelength_um, frames[b].wavelength_um
        if frames[a].epoch == frames[b].epoch or wave_a is None or wave_b is None:
            continue
        if not comparable_wavelengths(
            wave_a, wave_b, frames[a].detector, WAVELENGTH_MATCH_FRACTION
        ):
            continue
        gap, epochs = frames[b].mjd - frames[a].mjd, abs(frames[b].epoch - frames[a].epoch)
        if gap > span or (gap == span and epochs > apart):
            best, span, apart = (a, b), gap, epochs
    if best or len(frames) < 2:
        return best
    first: dict[int, int] = {}
    for position, frame in enumerate(frames):
        first.setdefault(frame.epoch, position)
    a, latest = first[min(first)], max(first)
    return a, len(frames) - 1 if latest == frames[a].epoch else first[latest]


def measure(
    frame: Aligned,
    draw: Draw,
    rng: np.random.Generator,
    psf: Literal["epsf", "gaussian"] = "gaussian",
) -> Measured | None:
    """Detection limit of one frame from STARS_PER_LEVEL artificial stars per flux step, drawn by
    `draw` at random places clear of its sources. None where the frame has no room for a star or
    no measurable noise.

    No detection here stops at sources.MAX_SOURCES, which only keeps the manifest small: in a
    crowded field the faintest stars would drop out of the list, not out of reach."""
    no_fits = np.zeros(frame.image.shape, dtype=bool)
    # Every source, by its peak pixel: enough to keep the stars clear of them.
    sources, _ = detect(frame, fit=no_fits, cap=False)
    allowed = _allowed(frame, np.array([(d.x, d.y) for d in sources]).reshape(-1, 2))
    if not allowed.any():
        return None
    noise = _point_noise(frame, draw, allowed)
    if not noise > 0:
        return None
    fluxes = np.array(LEVELS_SIGMA) * noise
    plan = rng.permutation(np.repeat(np.arange(fluxes.size), STARS_PER_LEVEL))
    injected, found = np.zeros(fluxes.size, dtype=int), np.zeros(fluxes.size, dtype=int)
    offsets: list[tuple[int, float]] = []
    start = 0
    while start < plan.size:
        xs, ys = _positions(allowed, rng, plan.size - start)
        if xs.size == 0:
            break
        steps = plan[start : start + xs.size]
        start += xs.size
        detections, _ = detect(
            frame._replace(image=frame.image + draw(xs, ys, fluxes[steps])),
            fit=_near(xs, ys, frame.image.shape),
            cap=False,
        )
        distance = _nearest(xs, ys, detections)
        hit = distance <= MATCH_RADIUS_PX
        np.add.at(injected, steps, 1)
        np.add.at(found, steps[hit], 1)
        offsets += zip(steps[hit].tolist(), distance[hit].tolist(), strict=True)
    # Noise peaks pass the threshold as often in the negated frame as in the frame itself, but no
    # source can make them there. Only where stars were set: next to a bright star the median sky
    # leaves a dark ring, which the negated frame turns into peaks.
    negated, _ = detect(frame._replace(image=-frame.image), fit=no_fits, cap=False)
    false = [d for d in negated if allowed[int(d.y), int(d.x)]]
    share = _monotonic(found / np.maximum(injected, 1), injected)
    flux50, flux90 = (_flux_at(share, fluxes, target) for target in (0.5, 0.9))
    # Position accuracy near the limit: the stars of the steps not yet found nine times in ten.
    near_limit = [d for step, d in offsets if share[step] < 0.9]
    limit = Completeness(
        psf=psf,
        injected=int(injected.sum()),
        noise_ujy=round(noise, 1),
        flux50_ujy=None if flux50 is None else round(flux50, 1),
        flux90_ujy=None if flux90 is None else round(flux90, 1),
        ab50=None if flux50 is None else round(ab_mag(flux50), 2),
        ab90=None if flux90 is None else round(ab_mag(flux90), 2),
        false_per_frame=len(false),
        offset_arcsec=round(float(np.median(near_limit)) * SPHEREX_PIXEL_SCALE_ARCSEC, 2)
        if near_limit
        else None,
    )
    return Measured(limit, fluxes.tolist(), injected.tolist(), found.tolist())


def ab_mag(flux_ujy: float) -> float:
    return 23.9 - 2.5 * math.log10(flux_ujy)


def _allowed(frame: Aligned, existing: np.ndarray) -> np.ndarray:
    """Grid pixels a star may be set on: covered, every pixel of the detection's 5 × 5 PSF fit
    usable around it, its local sky square on the grid and no detected source within
    CLEARANCE_PX."""
    usable = np.isfinite(frame.image) & frame.covered
    allowed = ndimage.binary_erosion(usable, structure=np.ones((5, 5), dtype=bool))
    inner = np.zeros_like(allowed)
    inner[EDGE_PX:-EDGE_PX, EDGE_PX:-EDGE_PX] = True
    allowed &= inner
    for x, y in existing:
        window, disc = _disc(x, y, CLEARANCE_PX, allowed.shape)
        allowed[window] &= ~disc
    return allowed


def _point_noise(frame: Aligned, draw: Draw, allowed: np.ndarray) -> float:
    """1σ total flux (µJy) of a point source in the frame: the robust scatter of the flux a PSF
    fit gives at the allowed pixels, after the local sky the detection removes."""
    cy, cx = (np.array(frame.image.shape) - 1) // 2
    unit = draw(np.array([float(cx)]), np.array([float(cy)]), np.array([1.0]))
    stamp = unit[cy - _HALF_PX : cy + _HALF_PX + 1, cx - _HALF_PX : cx + _HALF_PX + 1]
    local = np.nan_to_num(frame.image - _local_sky(frame))
    fitted = ndimage.correlate(local, stamp, mode="constant") / np.sum(stamp**2)
    return float(mad_std(fitted[allowed]))


def _positions(
    allowed: np.ndarray, rng: np.random.Generator, limit: int
) -> tuple[np.ndarray, np.ndarray]:
    """Up to `limit` random positions on allowed pixels, SEPARATION_PX or more apart."""
    free = allowed.copy()
    rows, cols = np.nonzero(allowed)
    r = SEPARATION_PX
    disc = np.hypot(*np.mgrid[-r : r + 1, -r : r + 1]) < r
    xs, ys = [], []
    for k in rng.permutation(rows.size):
        y, x = int(rows[k]), int(cols[k])
        if not free[y, x]:
            continue
        xs.append(x + rng.uniform(-0.5, 0.5))
        ys.append(y + rng.uniform(-0.5, 0.5))
        y0, y1 = max(0, y - r), min(free.shape[0], y + r + 1)
        x0, x1 = max(0, x - r), min(free.shape[1], x + r + 1)
        free[y0:y1, x0:x1] &= ~disc[y0 - y + r : y1 - y + r, x0 - x + r : x1 - x + r]
        if len(xs) == limit:
            break
    return np.array(xs), np.array(ys)


def _near(xs: np.ndarray, ys: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Pixels whose peak could be a found star: a centroid fit moves a peak by at most one pixel
    per axis, so peaks beyond MATCH_RADIUS_PX + √2 never match and need no fit."""
    near = np.zeros(shape, dtype=bool)
    for x, y in zip(xs, ys, strict=True):
        window, disc = _disc(x, y, MATCH_RADIUS_PX + math.sqrt(2), shape)
        near[window] |= disc
    return near


def _disc(
    x: float, y: float, radius: float, shape: tuple[int, int]
) -> tuple[tuple[slice, slice], np.ndarray]:
    """The grid window around (x, y) and which of its pixels lie within `radius` of it."""
    reach = math.ceil(radius)
    y0, x0 = max(0, math.floor(y) - reach), max(0, math.floor(x) - reach)
    y1 = min(shape[0], math.floor(y) + reach + 2)
    x1 = min(shape[1], math.floor(x) + reach + 2)
    rows, cols = np.ogrid[y0:y1, x0:x1]
    return (slice(y0, y1), slice(x0, x1)), np.hypot(cols - x, rows - y) <= radius


def _nearest(xs: np.ndarray, ys: np.ndarray, detections: list[Detection]) -> np.ndarray:
    """Distance (px) from each star to the nearest detection; inf without detections."""
    if not detections:
        return np.full(xs.size, np.inf)
    dx = xs[:, None] - np.array([d.x for d in detections])
    dy = ys[:, None] - np.array([d.y for d in detections])
    return np.hypot(dx, dy).min(axis=1)


def _monotonic(share: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """The share found, made non-decreasing with flux by pooling adjacent steps that break the
    order (isotonic regression, weighted by the stars per step): chance must not make a fainter
    step look better than a brighter one."""
    pools: list[list[float]] = []  # [share, weight, steps]
    for value, weight in zip(share.tolist(), weights.tolist(), strict=True):
        pools.append([value, weight, 1])
        while len(pools) > 1 and pools[-2][0] > pools[-1][0]:
            (a, wa, na), (b, wb, nb) = pools.pop(-2), pools.pop()
            pools.append([(a * wa + b * wb) / (wa + wb) if wa + wb else a, wa + wb, na + nb])
    return np.concatenate([np.full(int(n), value) for value, _, n in pools])


def _flux_at(share: np.ndarray, fluxes: np.ndarray, target: float) -> float | None:
    """Flux at which the share found reaches `target`, interpolated in log flux (in magnitudes)
    between the steps around it; None when the faintest step reaches it already or none does."""
    above = np.nonzero(share >= target)[0]
    if above.size == 0 or above[0] == 0:
        return None
    k = int(above[0])
    t = (target - share[k - 1]) / (share[k] - share[k - 1])
    return float(fluxes[k - 1] * (fluxes[k] / fluxes[k - 1]) ** t)


def _gaussian_stars(grid: WCS, shape: tuple[int, int], fwhm: float = FWHM_PX) -> Draw:
    """Stars as Gaussians of `fwhm` integrated over the grid pixels."""
    sigma = fwhm * gaussian_fwhm_to_sigma
    to_ujy = proj_plane_pixel_area(grid) * _UJY_PER_MJY_SR_DEG2

    def draw(xs: np.ndarray, ys: np.ndarray, fluxes: np.ndarray) -> np.ndarray:
        image = np.zeros(shape)
        for x, y, flux in zip(xs, ys, fluxes, strict=True):
            col, row = math.floor(x), math.floor(y)
            cols = np.arange(max(0, col - _HALF_PX), min(shape[1], col + _HALF_PX + 2))
            rows = np.arange(max(0, row - _HALF_PX), min(shape[0], row + _HALF_PX + 2))
            gx = ndtr((cols + 0.5 - x) / sigma) - ndtr((cols - 0.5 - x) / sigma)
            gy = ndtr((rows + 0.5 - y) / sigma) - ndtr((rows - 0.5 - y) / sigma)
            image[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1] += (
                flux / to_ujy * np.outer(gy, gx)
            )
        return image

    return draw


def _epsf_stars(cutout: Path, grid: WCS, shape: tuple[int, int]) -> Draw | None:
    """Stars drawn with the cutout's ePSF at the field centre on its pixels and resampled onto the
    grid like frames.align; None when the cutout carries no EPSF table."""
    ra, dec = grid.pixel_to_world_values((shape[1] - 1) / 2, (shape[0] - 1) / 2)
    found = cutout_epsf(cutout, float(ra), float(dec))
    if found is None:
        return None
    model, wcs, pixels = found
    to_ujy = proj_plane_pixel_area(wcs) * _UJY_PER_MJY_SR_DEG2

    def draw(xs: np.ndarray, ys: np.ndarray, fluxes: np.ndarray) -> np.ndarray:
        image = np.zeros(pixels)
        cx, cy = wcs.world_to_pixel_values(*grid.pixel_to_world_values(xs, ys))
        for x, y, flux in zip(np.atleast_1d(cx), np.atleast_1d(cy), fluxes, strict=True):
            image += flux / to_ujy * pixel_psf(model, float(x), float(y), pixels)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # grid pixels beyond the cutout
            drawn, _ = reproject_interp((image, wcs), grid, shape_out=shape)
        return np.nan_to_num(drawn)

    return draw


def completeness_checks(measured: list[tuple[Frame, Measured]]) -> list[Check]:
    """One info check with the measured limits of A and B; none when no frame was measured."""
    if not measured:
        return []
    numbers = [frame.index + 1 for frame, _ in measured]
    texts = {target: [_limit(result, target) for _, result in measured] for target in (0.5, 0.9)}
    message = (
        "Detection limit measured by injecting "
        f"{sum(result.limit.injected for _, result in measured)} artificial stars: 50 % "
        f"{_per_frame([short for short, _ in texts[0.5]], numbers, 'found')}, 90 % "
        f"{_per_frame([short for short, _ in texts[0.9]], numbers)}"
    )
    drawn = {
        "epsf": "drawn with the SPHEREx ePSF of the frame's first exposure on its pixels and "
        "resampled like the data",
        "gaussian": f"drawn as Gaussians of FWHM {FWHM_PX:g} px, the PSF measured on the grid "
        "(the cutout carries no ePSF)",
    }
    detail = " ".join(
        f"Frame {number}: 50 % {fifty}, 90 % {ninety}; 1σ {result.limit.noise_ujy:g} µJy; found "
        f"{', '.join(map(str, result.found))} of {', '.join(map(str, result.injected))} stars in "
        f"steps of {', '.join(f'{level:g}' for level in LEVELS_SIGMA)}σ; "
        f"{result.limit.false_per_frame} detections in the negated frame where stars were set "
        "(noise peaks above the threshold)"
        + (
            f"; stars near the limit found {result.limit.offset_arcsec:g}″ (median) from where "
            "they were set"
            if result.limit.offset_arcsec is not None
            else ""
        )
        + f"; stars {drawn[result.limit.psf]}."
        for number, (_, result), (_, fifty), (_, ninety) in zip(
            numbers, measured, texts[0.5], texts[0.9], strict=True
        )
    )
    return [
        Check(
            code="DETECTION_LIMIT",
            severity="info",
            message=message,
            detail=f"{detail} Method: artificial point sources of known total flux, set where "
            "the frame has data at random places (seeded by the job, so a rebuild sets the same "
            f"stars) at least {EDGE_PX} px from the grid edge, "
            f"{CLEARANCE_PX} px from every detected source and {SEPARATION_PX} px from each "
            f"other, then searched for with the same ≥{THRESHOLD_SIGMA:g}σ detection as every "
            f"source, without its cap of {MAX_SOURCES} per frame; found means a detection within "
            f"{MATCH_RADIUS_PX:g} px ({MATCH_RADIUS_PX * SPHEREX_PIXEL_SCALE_ARCSEC:.1f}″). Only "
            "the A and B the blink opens with are measured, which keeps the job quick. The limits "
            "hold for point sources: a moving or extended object spreads its light and must be "
            "brighter.",
        )
    ]


def _limit(result: Measured, target: float) -> tuple[str, str]:
    """The flux at which `target` of the stars are found, short ('at 16.7 AB') and long ('at 732
    µJy (16.74 AB)'); 'fainter than' the faintest step when that one reaches it already."""
    flux = result.limit.flux50_ujy if target == 0.5 else result.limit.flux90_ujy
    if flux is not None:
        return f"at {ab_mag(flux):.1f} AB", f"at {flux:g} µJy ({ab_mag(flux):.2f} AB)"
    share = _monotonic(
        np.array(result.found) / np.maximum(result.injected, 1), np.array(result.injected)
    )
    if share[0] >= target:
        faintest = result.fluxes[0]
        return (
            f"fainter than {ab_mag(faintest):.1f} AB",
            f"fainter than {faintest:.4g} µJy ({ab_mag(faintest):.2f} AB), the faintest step",
        )
    return "not reached", "not reached within the steps"


def _per_frame(texts: list[str], numbers: list[int], verb: str = "") -> str:
    """'found at 16.7 AB' when every frame agrees, else per frame: 'found at 16.7 AB in frame 1
    and at 16.6 AB in frame 9'."""
    parts = (
        texts[:1]
        if len(set(texts)) == 1
        else [f"{text} in frame {n}" for text, n in zip(texts, numbers, strict=True)]
    )
    head = f"{verb} " if verb and texts[0] != "not reached" else ""
    return head + " and ".join(parts)
