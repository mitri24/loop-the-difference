"""SPHEREx effective PSF (ePSF): pick it for a detector position, place it on pixels, measure
with it.

EPSF, epsf_at and pixel_psf are mirrored in analysis-service/app/psf.py (the services share no
code): change both together; tests/test_psf.py compares them.

Format, checked on two real DR1 D6 cutouts (calibration file epsf_6_20260507.fits): the cutout
service sends the ePSF table of the whole detector as the binary table EPSF, one row per zone of
a regular grid (21 × 21; detector 3: 11 × 41) with the zone centre XCENTER/YCENTER in 0-based
detector pixels and a 33 × 33 ePSF, oversampled OVSMPX × OVSMPY = 5 × 5, centred on its middle
sample and summing to 1. An ePSF already contains the pixel response (Anderson & King 2000): a
source at (x0, y0) puts ePSF(x − x0, y − y0) into the pixel centred at (x, y). So it is sampled
at pixel centres, never integrated over pixels: sampled it reproduces the pipeline's NEFF_MEAN
(5.17 vs 5.15 px), integrated it would give 6.3 px. The cached cutouts keep the whole table.
"""

import math
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
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


def psf_flux(
    image: np.ndarray,
    variance: np.ndarray,
    background: float,
    psf: np.ndarray,
    sky_error: float = 0.0,
) -> tuple[float, float]:
    """Flux and 1σ error of a point source at a fixed position: the unit-flux PSF image `psf`
    fitted to `image` − `background` with inverse-variance weights,
    F = Σ(P·(I − b)/σ²) / Σ(P²/σ²), σ_F² = 1/Σ(P²/σ²) + (sky_error · Σ(P/σ²) / Σ(P²/σ²))², the
    second term for the uncertainty of the background. Pixels without a finite value or a
    positive variance carry no weight; NaN when none is left."""
    use = (psf != 0) & np.isfinite(image) & np.isfinite(variance) & (variance > 0)
    if not use.any():
        return math.nan, math.nan
    p, v = psf[use], variance[use]
    norm = float(np.sum(p * p / v))
    flux = float(np.sum(p * (image[use] - background) / v) / norm)
    return flux, math.hypot(1 / math.sqrt(norm), sky_error * float(np.sum(p / v)) / norm)


def psf_at(path: Path, ra: float, dec: float) -> np.ndarray | None:
    """Unit-flux image of a point source at (ra, dec) on the pixels of a cached cutout, from the
    ePSF of the detector zone there; None when the cutout carries no EPSF table."""
    found = cutout_epsf(path, ra, dec)
    if found is None:
        return None
    model, wcs, shape = found
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    return pixel_psf(model, x, y, shape)


def cutout_epsf(path: Path, ra: float, dec: float) -> tuple[EPSF, WCS, tuple[int, int]] | None:
    """The ePSF of the detector zone at (ra, dec) in a cached cutout, with the cutout's WCS and
    shape; None when the cutout carries no EPSF table."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as hdul:
            if "EPSF" not in hdul:
                return None
            header = hdul["IMAGE"].header
            wcs = WCS(header)
            x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
            # The cutout's LINEAR 'A' WCS gives its position on the detector.
            dx = float(header.get("CRVAL1A", 0.0)) + 1.0 - float(header.get("CRPIX1A", 1.0))
            dy = float(header.get("CRVAL2A", 0.0)) + 1.0 - float(header.get("CRPIX2A", 1.0))
            model = epsf_at(hdul["EPSF"], x + dx, y + dy)
            return model, wcs, (header["NAXIS2"], header["NAXIS1"])
