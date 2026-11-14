import warnings
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_area

from app.frames import unusable_bits

# SPHEREx PSF FWHM is about two pixels: the aperture holds the core, the annulus the local sky.
APERTURE_RADIUS_PX = 2.0
ANNULUS_PX = (4.0, 7.0)
_MJY_SR_TO_UJY_PER_DEG2 = 1e12 * (np.pi / 180) ** 2
# Sub-pixel sampling of the aperture edge: the PSF is undersampled, so whole pixels would jitter.
_SUBSAMPLE = 5


def forced_photometry(
    path: Path,
    ra: float,
    dec: float,
    radius_px: float = APERTURE_RADIUS_PX,
    annulus_px: tuple[float, float] = ANNULUS_PX,
) -> tuple[float, float, bool] | tuple[None, None, bool]:
    """Background-subtracted aperture flux (µJy), its 1σ error and a flag, quick-look only.

    No aperture correction: the flux is the PSF core, comparable between visits, not a total flux.
    The flag says that the aperture holds pixels the archive marks unusable (e.g. saturation):
    the flux is still measured, so nothing is hidden, but it must be shown as unreliable.
    """
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
    aperture = weight > 0
    sky = finite & ~unusable & (distance >= annulus_px[0]) & (distance <= annulus_px[1])
    height, width = image.shape
    inside = radius_px - 0.5 <= x <= width - 0.5 - radius_px and (
        radius_px - 0.5 <= y <= height - 0.5 - radius_px
    )
    # A clipped or masked aperture biases the flux low: no number is better than a wrong one.
    if not inside or not finite[aperture].all() or sky.sum() < 2:
        return None, None, False

    background = np.median(image[sky])
    w = weight[aperture]
    flux = np.sum(w * (image[aperture] - background))
    # Pixel noise from VARIANCE plus the uncertainty of the sky median (√(π/2) × that of a mean).
    sky_error = np.sqrt(np.pi / 2) * np.std(image[sky], ddof=1) / np.sqrt(sky.sum())
    error_squared = np.sum(w**2 * variance[aperture]) + (w.sum() * sky_error) ** 2
    if not error_squared >= 0:
        return None, None, False
    error = np.sqrt(error_squared)
    to_ujy = proj_plane_pixel_area(wcs) * _MJY_SR_TO_UJY_PER_DEG2
    return float(flux * to_ujy), float(error * to_ujy), bool(unusable[aperture].any())


def _aperture_weights(dx: np.ndarray, dy: np.ndarray, radius_px: float) -> np.ndarray:
    """Fraction of each pixel inside the circle, from a _SUBSAMPLE × _SUBSAMPLE grid per pixel."""
    offsets = (np.arange(_SUBSAMPLE) + 0.5) / _SUBSAMPLE - 0.5
    sub_x = dx[..., None, None] + offsets[None, :]
    sub_y = dy[..., None, None] + offsets[:, None]
    return (np.hypot(sub_x, sub_y) <= radius_px).mean(axis=(-2, -1))
