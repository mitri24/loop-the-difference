"""Alignment onto a common grid, background estimation and display rendering.

Every frame shown to users is resampled with ``reproject`` onto ONE tangent-plane
grid centred on the target (at the epoch of the data) with the native SPHEREx pixel
scale (6.15"/px). We never upsample silently: what users see are real pixels.
"""

from __future__ import annotations

import io
import math
import warnings
from dataclasses import dataclass

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

from .config import settings
from .cutouts import HARD_FLAGS, Cutout

# Colours shared with frontend/src/styles/tokens.css (see design-system.md).
NO_DATA_RGB = (58, 28, 66)  # --img-nodata
DIVERGING_MID = (56, 56, 53)  # --div-mid
DIVERGING_POS = (240, 112, 100)  # --div-pos  (brighter in A)
DIVERGING_NEG = (110, 170, 240)  # --div-neg  (brighter in B)


@dataclass
class Grid:
    ra: float
    dec: float
    npix: int
    pixel_arcsec: float

    @property
    def fov_arcmin(self) -> float:
        return self.npix * self.pixel_arcsec / 60

    @property
    def wcs(self) -> WCS:
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [self.ra, self.dec]
        c = (self.npix + 1) / 2  # FITS 1-based centre
        w.wcs.crpix = [c, c]
        s = self.pixel_arcsec / 3600
        w.wcs.cdelt = [-s, s]
        w.wcs.radesys = "ICRS"
        return w

    def header_dict(self) -> dict[str, float | str]:
        h = self.wcs.to_header()
        h["NAXIS1"] = self.npix
        h["NAXIS2"] = self.npix
        return {k: h[k] for k in h if k not in ("COMMENT", "HISTORY", "")}


def make_grid(ra: float, dec: float, fov_arcmin: float) -> Grid:
    pix = settings.native_pixel_arcsec
    npix = max(9, math.ceil(fov_arcmin * 60 / pix))
    if npix % 2 == 0:
        npix += 1  # odd so the target sits on the centre of a pixel
    return Grid(ra=ra, dec=dec, npix=npix, pixel_arcsec=pix)


def cutout_size_deg(fov_arcmin: float) -> float:
    # Request a margin so that any detector rotation still covers the square grid.
    return fov_arcmin / 60 * 1.5


@dataclass
class Aligned:
    image: np.ndarray  # background-subtracted MJy/sr, NaN where no data
    variance: np.ndarray
    hard_mask: np.ndarray  # bool: unusable pixels (or no data)
    flags: np.ndarray  # int64 nearest-neighbour resampled flags
    coverage: float
    background: float
    noise: float


def align(cutout: Cutout, grid: Grid) -> Aligned:
    shape = (grid.npix, grid.npix)
    target_wcs = grid.wcs
    hard = cutout.mask(HARD_FLAGS)
    img = np.where(hard, np.nan, cutout.image).astype(np.float64)
    var = np.where(hard, np.nan, cutout.variance).astype(np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        a_img, footprint = reproject_interp((img, cutout.wcs), target_wcs, shape, order="bilinear")
        a_var, _ = reproject_interp((var, cutout.wcs), target_wcs, shape, order="bilinear")
        a_flags, _ = reproject_interp(
            (cutout.flags.astype(np.float64), cutout.wcs),
            target_wcs,
            shape,
            order="nearest-neighbor",
        )
    valid = (footprint > 0) & np.isfinite(a_img)
    flags = np.where(np.isfinite(a_flags), a_flags, 0).astype(np.int64)
    coverage = float((footprint > 0).mean())
    bkg, noise = background_stats(a_img, valid)
    a_img = np.where(valid, a_img - bkg, np.nan)
    a_var = np.where(valid, a_var, np.nan)
    return Aligned(a_img, a_var, ~valid, flags, coverage, bkg, noise)


def background_stats(img: np.ndarray, valid: np.ndarray) -> tuple[float, float]:
    """Sigma-clipped median background and robust noise (MJy/sr)."""
    data = img[valid]
    if data.size < 10:
        return 0.0, float("nan")
    _, median, std = sigma_clipped_stats(data, sigma=3.0, maxiters=5)
    return float(median), float(std)


def display_limits(img: np.ndarray, noise: float) -> tuple[float, float]:
    """Robust display range: from -3σ below background to the 99.7th percentile."""
    finite = img[np.isfinite(img)]
    if finite.size == 0:
        return 0.0, 1.0
    lo = -3.0 * noise if math.isfinite(noise) and noise > 0 else float(np.percentile(finite, 1))
    hi = float(np.percentile(finite, 99.7))
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def render_png(
    img: np.ndarray, lo: float, hi: float, *, diverging: bool = False, scale: int = 1
) -> bytes:
    """8-bit RGB PNG. Sequential: asinh greyscale. Diverging: grey midpoint, red/blue poles."""
    finite = np.isfinite(img)
    if diverging:
        lim = max(abs(lo), abs(hi), 1e-12)
        t = np.clip(np.where(finite, img, 0) / lim, -1, 1)[..., None]
        # Diverging pair (design-system.md): neutral dark-grey midpoint, red = brighter
        # in A (earlier), blue = brighter in B (later). Never a hue at the midpoint.
        mid = np.array(DIVERGING_MID, dtype=float)
        pos = np.array(DIVERGING_POS, dtype=float)
        neg = np.array(DIVERGING_NEG, dtype=float)
        a = np.abs(t) ** 0.7  # mild gamma so faint residuals stay visible
        rgb = np.where(t >= 0, mid + (pos - mid) * a, mid + (neg - mid) * a)
        rgb[~finite] = NO_DATA_RGB
        arr = rgb.astype(np.uint8)
    else:
        x = np.clip((np.where(finite, img, lo) - lo) / (hi - lo), 0, 1)
        y = np.arcsinh(10 * x) / np.arcsinh(10)
        arr8 = (y * 255).astype(np.uint8)
        rgb = np.stack([arr8] * 3, axis=-1)
        rgb[~finite] = NO_DATA_RGB  # "no data" is visibly different from black sky
        arr = rgb
    # FITS row 0 is the bottom (south); images display north up.
    im = Image.fromarray(np.ascontiguousarray(np.flipud(arr)))
    if scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def stack(aligned: list[Aligned]) -> tuple[np.ndarray, np.ndarray, float]:
    """Inverse-variance weighted mean of aligned, background-subtracted frames."""
    imgs = np.stack([a.image for a in aligned])
    vars_ = np.stack([a.variance for a in aligned])
    w = np.where(np.isfinite(imgs) & np.isfinite(vars_) & (vars_ > 0), 1.0 / vars_, 0.0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(wsum > 0, (np.nan_to_num(imgs) * w).sum(axis=0) / wsum, np.nan)
        var = np.where(wsum > 0, 1.0 / wsum, np.nan)
    coverage = float((wsum > 0).mean())
    return mean, var, coverage
