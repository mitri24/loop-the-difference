import warnings
from pathlib import Path
from typing import NamedTuple

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_area

from app.frames import unusable_bits
from app.psf import psf_at, psf_flux

# SPHEREx PSF FWHM is about two pixels: the aperture holds the core, the annulus the local sky.
APERTURE_RADIUS_PX = 2.0
ANNULUS_PX = (4.0, 7.0)
_MJY_SR_TO_UJY_PER_DEG2 = 1e12 * (np.pi / 180) ** 2
# Sub-pixel sampling of the aperture edge: the PSF is undersampled, so whole pixels would jitter.
_SUBSAMPLE = 5
SKIP_EDGE = "target at the cutout edge"
SKIP_NAN = "NaN pixels in the aperture"
SKIP_SKY = "too few usable sky pixels"
SKIP_VARIANCE = "invalid VARIANCE"


class _Measurable(NamedTuple):
    """A cutout around the target that gives a flux, with its sky level and unit conversion."""

    image: np.ndarray
    variance: np.ndarray
    unusable: np.ndarray
    weight: np.ndarray  # share of each pixel inside the aperture
    background: float
    sky_error: float
    to_ujy: float

    @property
    def flagged(self) -> bool:
        return bool(self.unusable[self.weight > 0].any())


def forced_photometry(
    path: Path,
    ra: float,
    dec: float,
    radius_px: float = APERTURE_RADIUS_PX,
    annulus_px: tuple[float, float] = ANNULUS_PX,
) -> tuple[float, float, bool] | str:
    """Background-subtracted aperture flux (µJy), its 1σ error and a flag, quick-look only.

    Without a flux it returns why, as words for the skip check: one of the SKIP_* reasons.

    No aperture correction: the flux is the PSF core, comparable between visits; times
    aperture_correction it becomes the total flux of a point source.
    The flag says that the aperture holds pixels the archive marks unusable (e.g. saturation):
    the flux is still measured, so nothing is hidden, but it must be shown as unreliable.
    """
    cut = _measurable(path, ra, dec, radius_px, annulus_px)
    if isinstance(cut, str):
        return cut
    aperture = cut.weight > 0
    w = cut.weight[aperture]
    flux = np.sum(w * (cut.image[aperture] - cut.background))
    error_squared = np.sum(w**2 * cut.variance[aperture]) + (w.sum() * cut.sky_error) ** 2
    if not error_squared >= 0:
        return SKIP_VARIANCE
    return float(flux * cut.to_ujy), float(np.sqrt(error_squared) * cut.to_ujy), cut.flagged


def psf_photometry(
    path: Path, ra: float, dec: float, annulus_px: tuple[float, float] = ANNULUS_PX
) -> tuple[float, float, bool] | str | None:
    """Total flux (µJy) of a point source at (ra, dec), its 1σ error and the flag of
    forced_photometry: the SPHEREx ePSF there, fitted with inverse-variance weights above the sky
    median of the same annulus (psf.psf_flux). Pixels the archive marks unusable carry no
    weight. It skips where forced_photometry does; None without an EPSF table."""
    point = psf_at(path, ra, dec)
    if point is None:
        return None
    cut = _measurable(path, ra, dec, APERTURE_RADIUS_PX, annulus_px)
    if isinstance(cut, str):
        return cut
    variance = np.where(cut.unusable, np.nan, cut.variance)
    flux, error = psf_flux(cut.image, variance, cut.background, point, cut.sky_error)
    if not error > 0:
        return SKIP_VARIANCE
    return flux * cut.to_ujy, error * cut.to_ujy, cut.flagged


def aperture_correction(
    path: Path, ra: float, dec: float, radius_px: float = APERTURE_RADIUS_PX
) -> float | None:
    """Factor from the aperture flux of forced_photometry to the total flux of a point source:
    1 / the share of the SPHEREx ePSF at the target inside the aperture, with the same sub-pixel
    weights. Total means within the ePSF model (±3.2 px). None without an EPSF table, or where
    forced_photometry gives no flux because the aperture leaves the cutout."""
    point = psf_at(path, ra, dec)
    if point is None:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        x, y = WCS(fits.getheader(path, "IMAGE")).world_to_pixel_values(ra, dec)
    if not _inside(x, y, point.shape, radius_px):
        return None
    yy, xx = np.indices(point.shape)
    return 1 / float(np.sum(_aperture_weights(xx - x, yy - y, radius_px) * point))


def _measurable(
    path: Path, ra: float, dec: float, radius_px: float, annulus_px: tuple[float, float]
) -> _Measurable | str:
    """The cutout around (ra, dec) with the sky median of the annulus, or the SKIP_* reason why
    it gives no flux."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as hdul:
            header = hdul["IMAGE"].header
            image = hdul["IMAGE"].data.astype(np.float64)
            variance = hdul["VARIANCE"].data.astype(np.float64)
            unusable = np.zeros(image.shape, dtype=bool)
            if "FLAGS" in hdul:
                flags = hdul["FLAGS"]
                unusable = (flags.data & unusable_bits(flags.header)) != 0
            wcs = WCS(header)
    x, y = wcs.world_to_pixel_values(ra, dec)
    yy, xx = np.indices(image.shape)
    distance = np.hypot(xx - x, yy - y)
    finite = np.isfinite(image) & np.isfinite(variance)
    weight = _aperture_weights(xx - x, yy - y, radius_px)
    sky = finite & ~unusable & (distance >= annulus_px[0]) & (distance <= annulus_px[1])
    # A clipped or masked aperture biases the flux low: no number is better than a wrong one.
    if not _inside(x, y, image.shape, radius_px):
        return SKIP_EDGE
    if not finite[weight > 0].all():
        return SKIP_NAN
    if sky.sum() < 2:
        return SKIP_SKY
    # The uncertainty of the sky median: √(π/2) × that of a mean.
    sky_error = np.sqrt(np.pi / 2) * np.std(image[sky], ddof=1) / np.sqrt(sky.sum())
    to_ujy = proj_plane_pixel_area(wcs) * _MJY_SR_TO_UJY_PER_DEG2
    return _Measurable(
        image, variance, unusable, weight, float(np.median(image[sky])), sky_error, to_ujy
    )


def _inside(x: float, y: float, shape: tuple[int, ...], radius_px: float) -> bool:
    height, width = shape
    return radius_px - 0.5 <= x <= width - 0.5 - radius_px and (
        radius_px - 0.5 <= y <= height - 0.5 - radius_px
    )


def _aperture_weights(dx: np.ndarray, dy: np.ndarray, radius_px: float) -> np.ndarray:
    """Fraction of each pixel inside the circle, from a _SUBSAMPLE × _SUBSAMPLE grid per pixel."""
    offsets = (np.arange(_SUBSAMPLE) + 0.5) / _SUBSAMPLE - 0.5
    sub_x = dx[..., None, None] + offsets[None, :]
    sub_y = dy[..., None, None] + offsets[:, None]
    return (np.hypot(sub_x, sub_y) <= radius_px).mean(axis=(-2, -1))
