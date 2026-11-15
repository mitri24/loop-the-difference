"""SPHEREx effective PSF (ePSF): pick it for a detector position, place it on pixels, and match
two frames with it (ZOGY).

EPSF, epsf_at and pixel_psf are mirrored in backend/app/psf.py (the services share no code):
change both together; backend/tests/test_psf.py compares them.

Format, checked on two real DR1 D6 cutouts (calibration file epsf_6_20260507.fits): the cutout
service sends the ePSF table of the whole detector as the binary table EPSF, one row per zone of
a regular grid (21 × 21; detector 3: 11 × 41) with the zone centre XCENTER/YCENTER in 0-based
detector pixels and a 33 × 33 ePSF, oversampled OVSMPX × OVSMPY = 5 × 5, centred on its middle
sample and summing to 1. An ePSF already contains the pixel response (Anderson & King 2000): a
source at (x0, y0) puts ePSF(x − x0, y − y0) into the pixel centred at (x, y). So it is sampled
at pixel centres, never integrated over pixels: sampled it reproduces the pipeline's NEFF_MEAN
(5.17 vs 5.15 px), integrated it would give 6.3 px.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from astropy.io import fits
from scipy import ndimage


@dataclass(frozen=True)
class EPSF:
    data: np.ndarray  # oversampled ePSF, centred on its middle sample, sum 1
    oversampling: tuple[int, int]  # samples per detector pixel along x, y


def epsf_at(table: fits.BinTableHDU, x: float, y: float) -> EPSF:
    """The ePSF at 0-based detector pixel (x, y): bilinear between the four nearest zone
    centres, the edge zones held constant beyond their centres."""
    rows = table.data
    xc = np.asarray(rows["XCENTER"], dtype=float)
    yc = np.asarray(rows["YCENTER"], dtype=float)
    xs, ys = np.unique(xc), np.unique(yc)
    stamps = np.asarray(rows["EPSF"], dtype=float)
    cube = np.zeros((ys.size, xs.size, *stamps.shape[1:]))
    cube[np.searchsorted(ys, yc), np.searchsorted(xs, xc)] = stamps
    x0, x1, tx = _bracket(xs, x)
    y0, y1, ty = _bracket(ys, y)
    data = (1 - ty) * ((1 - tx) * cube[y0, x0] + tx * cube[y0, x1]) + ty * (
        (1 - tx) * cube[y1, x0] + tx * cube[y1, x1]
    )
    oversampling = (int(table.header["OVSMPX"]), int(table.header["OVSMPY"]))
    return EPSF(data / data.sum(), oversampling)


def _bracket(centres: np.ndarray, value: float) -> tuple[int, int, float]:
    if centres.size == 1:
        return 0, 0, 0.0
    i = int(np.clip(np.searchsorted(centres, value) - 1, 0, centres.size - 2))
    t = (value - centres[i]) / (centres[i + 1] - centres[i])
    return i, i + 1, float(np.clip(t, 0.0, 1.0))


def pixel_psf(psf: EPSF, x0: float, y0: float, shape: tuple[int, int]) -> np.ndarray:
    """A unit-flux point source at pixel (x0, y0) on a pixel grid of `shape`: the ePSF sampled
    at every pixel centre, normalised so the whole source sums to 1 (less where it leaves the
    grid)."""
    ovx, ovy = psf.oversampling
    cy, cx = (np.asarray(psf.data.shape) - 1) / 2
    cols = np.arange(math.floor(x0 - cx / ovx), math.ceil(x0 + cx / ovx) + 1)
    rows = np.arange(math.floor(y0 - cy / ovy), math.ceil(y0 + cy / ovy) + 1)
    yy, xx = np.meshgrid(rows, cols, indexing="ij")
    stamp = ndimage.map_coordinates(
        psf.data, [cy + ovy * (yy - y0), cx + ovx * (xx - x0)], order=3, mode="constant"
    )
    stamp /= stamp.sum()
    inside = (yy >= 0) & (yy < shape[0]) & (xx >= 0) & (xx < shape[1])
    out = np.zeros(shape)
    out[yy[inside], xx[inside]] = stamp[inside]
    return out


def zogy(
    new: np.ndarray,
    ref: np.ndarray,
    var_new: np.ndarray,
    var_ref: np.ndarray,
    psf_new: np.ndarray,
    psf_ref: np.ndarray,
    flux_ratio: float = 1.0,
    sigma_ast: float = 0.0,
    floor: float = 0.0,
) -> np.ndarray:
    """Corrected ZOGY score S_corr of `new` against `ref`, positive where `new` is brighter
    (Zackay, Ofek & Gal-Yam 2016, ApJ 830, 27): S = S_new − S_ref from the matching kernels,
    divided by its standard deviation.

    Inputs are background-subtracted images and their variance maps on one grid, finite
    everywhere, and odd PSF stamps centred on the middle pixel with sum 1; `new` ≈
    flux_ratio × `ref` for a constant source. The variance of S holds the pixel variance of
    both frames filtered by the ZOGY kernels (source noise included), the registration noise
    `sigma_ast` (px), and `floor` × the PSF-matched flux of each frame in quadrature, for the
    ePSF model and calibration errors that the kernels cannot remove."""
    pad = max(*psf_new.shape, *psf_ref.shape)
    shape = (new.shape[0] + 2 * pad, new.shape[1] + 2 * pad)

    def spectrum(image: np.ndarray, fill: float = 0.0) -> np.ndarray:
        return np.fft.fft2(np.pad(image, pad, constant_values=fill))

    def otf(stamp: np.ndarray) -> np.ndarray:
        big = np.zeros(shape)
        big[: stamp.shape[0], : stamp.shape[1]] = stamp
        return np.fft.fft2(np.roll(big, (-(stamp.shape[0] // 2), -(stamp.shape[1] // 2)), (0, 1)))

    p_n, p_r = otf(psf_new), otf(psf_ref)
    f_n, f_r = flux_ratio, 1.0
    s2_n, s2_r = float(np.median(var_new)), float(np.median(var_ref))
    den = s2_n * f_r**2 * np.abs(p_r) ** 2 + s2_r * f_n**2 * np.abs(p_n) ** 2
    den = np.maximum(den, 1e-12 * den.max())
    k_n = f_r**2 * f_n * np.abs(p_r) ** 2 * np.conj(p_n) / den
    k_r = f_n**2 * f_r * np.abs(p_n) ** 2 * np.conj(p_r) / den
    s_new = np.fft.ifft2(k_n * spectrum(new)).real
    s_ref = np.fft.ifft2(k_r * spectrum(ref)).real
    variance = np.zeros(shape)
    for kernel, var, s2 in ((k_n, var_new, s2_n), (k_r, var_ref, s2_r)):
        k2 = np.fft.fft2(np.fft.ifft2(kernel).real ** 2)
        variance += np.fft.ifft2(k2 * spectrum(var, s2)).real
    for score in (s_new, s_ref):
        gy, gx = np.gradient(score)
        variance += sigma_ast**2 * (gx**2 + gy**2) + (floor * score) ** 2
    score = (s_new - s_ref) / np.sqrt(np.maximum(variance, 1e-300))
    return score[pad:-pad, pad:-pad]
