import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app.photometry import forced_photometry

RA, DEC = 133.795, -7.245
SIZE = 41
SCALE_DEG = 6.15 / 3600
UJY_PER_MJY_SR = 1e12 * np.radians(SCALE_DEG) ** 2


def _cutout(tmp_path, image, variance, flags=None):
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [(SIZE + 1) / 2, (SIZE + 1) / 2]
    wcs.wcs.cdelt = [-SCALE_DEG, SCALE_DEG]
    tmp_path.mkdir(exist_ok=True)
    path = tmp_path / "cutout.fits"
    hdus = [
        fits.PrimaryHDU(),
        fits.ImageHDU(image.astype(np.float32), wcs.to_header(), name="IMAGE"),
        fits.ImageHDU(variance.astype(np.float32), name="VARIANCE"),
    ]
    if flags is not None:
        header = fits.Header(
            {"MSKN0000": "SOURCE", "MSKM0000": 1, "MSKN0001": "HOT", "MSKM0001": 2}
        )
        hdus.append(fits.ImageHDU(flags.astype(np.int32), header, name="FLAGS"))
    fits.HDUList(hdus).writeto(path)
    return path


def _star(source_mjy_sr: float, sky: float = 3.0) -> np.ndarray:
    image = np.full((SIZE, SIZE), sky)
    centre = SIZE // 2
    image[centre - 1 : centre + 2, centre - 1 : centre + 2] += source_mjy_sr / 9
    return image


def test_known_source_flux_is_recovered_above_the_sky(tmp_path):
    path = _cutout(tmp_path, _star(90.0), np.full((SIZE, SIZE), 0.04))

    flux, error, _ = forced_photometry(path, RA, DEC, radius_px=2.5)

    assert flux == pytest.approx(90.0 * UJY_PER_MJY_SR, rel=1e-4)
    # Flat sky: the VARIANCE summed over the aperture, at most its area π·2.5² pixels.
    assert 0.9 * np.pi * 2.5**2 < (error / UJY_PER_MJY_SR) ** 2 / 0.04 < np.pi * 2.5**2


@pytest.mark.parametrize("offset_px", [0.0, 0.3, 0.5])
def test_aperture_area_does_not_jump_with_the_sub_pixel_position(tmp_path, offset_px):
    # A flat excess of 1 over a zero sky ring: the flux counts the aperture area in pixels.
    image = np.zeros((SIZE, SIZE))
    yy, xx = np.indices(image.shape)
    centre = SIZE // 2 + offset_px
    image[np.hypot(xx - centre, yy - SIZE // 2) <= 3.0] = 1.0
    path = _cutout(tmp_path, image, np.full((SIZE, SIZE), 0.04))

    ra = RA - offset_px * SCALE_DEG / np.cos(np.radians(DEC))
    flux, _, _ = forced_photometry(path, ra, DEC)

    assert flux / UJY_PER_MJY_SR == pytest.approx(np.pi * 2.0**2, rel=0.02)


def test_error_grows_with_the_variance_extension(tmp_path):
    low = forced_photometry(
        _cutout(tmp_path / "a", _star(90.0), np.full((SIZE, SIZE), 0.01)), RA, DEC
    )
    high = forced_photometry(
        _cutout(tmp_path / "b", _star(90.0), np.full((SIZE, SIZE), 1.0)), RA, DEC
    )

    assert low[0] == pytest.approx(high[0])
    assert high[1] == pytest.approx(10 * low[1], rel=1e-4)


def test_noisy_sky_error_matches_the_scatter_of_measurements(tmp_path):
    rng = np.random.default_rng(1)
    sigma = 0.5
    fluxes, errors = [], []
    for run in range(200):
        image = _star(90.0) + rng.normal(0, sigma, (SIZE, SIZE))
        flux, error, _ = forced_photometry(
            _cutout(tmp_path / str(run), image, np.full((SIZE, SIZE), sigma**2)), RA, DEC
        )
        fluxes.append(flux)
        errors.append(error)

    assert np.mean(fluxes) == pytest.approx(90.0 * UJY_PER_MJY_SR, rel=0.05)
    assert np.std(fluxes) == pytest.approx(np.median(errors), rel=0.2)


@pytest.mark.parametrize("ra_offset_px", [0, SIZE // 2])
def test_masked_or_clipped_aperture_gives_no_flux(tmp_path, ra_offset_px):
    image = _star(90.0)
    if ra_offset_px == 0:
        image[SIZE // 2, SIZE // 2] = np.nan
    path = _cutout(tmp_path, image, np.full((SIZE, SIZE), 0.04))

    ra = RA - ra_offset_px * SCALE_DEG / np.cos(np.radians(DEC))
    assert forced_photometry(path, ra, DEC) == (None, None, False)


@pytest.mark.parametrize(("bit", "flagged"), [(1, False), (2, True)])
def test_unusable_flag_in_the_aperture_keeps_the_flux_and_marks_it(tmp_path, bit, flagged):
    flags = np.zeros((SIZE, SIZE))
    flags[SIZE // 2, SIZE // 2] = bit
    path = _cutout(tmp_path, _star(90.0), np.full((SIZE, SIZE), 0.04), flags)

    flux, _, marked = forced_photometry(path, RA, DEC)

    assert flux == pytest.approx(90.0 * UJY_PER_MJY_SR, rel=0.02)
    assert marked is flagged


def test_flagged_pixel_in_the_sky_ring_does_not_change_the_flux(tmp_path):
    image, flags = _star(90.0), np.zeros((SIZE, SIZE))
    variance = np.full((SIZE, SIZE), 0.04)
    clean = forced_photometry(_cutout(tmp_path / "clean", image, variance, flags), RA, DEC)
    image[SIZE // 2, SIZE // 2 + 5] = 1e6
    flags[SIZE // 2, SIZE // 2 + 5] = 2

    assert forced_photometry(_cutout(tmp_path / "hot", image, variance, flags), RA, DEC) == clean


def test_negative_variance_gives_no_flux(tmp_path):
    path = _cutout(tmp_path, _star(90.0), np.full((SIZE, SIZE), -1e6))

    assert forced_photometry(path, RA, DEC) == (None, None, False)
