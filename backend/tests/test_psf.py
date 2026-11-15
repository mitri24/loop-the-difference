"""SPHEREx ePSF: pixels, aperture correction and PSF photometry (no network).

The ePSF tables are synthetic but built like the archive's EPSF extension (checked on real
DR1 D6 cutouts): one row per zone, XCENTER/YCENTER in 0-based detector pixels, a 33 × 33
float64 ePSF oversampled 5 × 5 that sums to 1, OVSMPX/OVSMPY in the header."""

import ast
import math
import os
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from scipy.special import ndtr

from app import psf
from app.photometry import SKIP_EDGE, _aperture_weights, aperture_correction, forced_photometry

RA, DEC = 133.795, -7.245
ANALYSIS_PSF = Path(__file__).resolve().parents[2] / "analysis-service" / "app" / "psf.py"
SHARED = ("EPSF", "epsf_at", "_bracket", "pixel_psf")
SIZE = 41
SCALE_DEG = 6.15 / 3600
UJY_PER_MJY_SR = 1e12 * np.radians(SCALE_DEG) ** 2


def pixel_gaussian(sx: float, sy: float, ov: int = 5, n: int = 33) -> np.ndarray:
    """ePSF of a Gaussian PSF: integrated over one detector pixel, sampled ov times per pixel."""
    d = (np.arange(n) - (n - 1) / 2) / ov
    e = np.outer(
        ndtr((d + 0.5) / sy) - ndtr((d - 0.5) / sy), ndtr((d + 0.5) / sx) - ndtr((d - 0.5) / sx)
    )
    return e / e.sum()


def epsf_table(stamp, nx: int = 2, ny: int = 3, ov: int = 5) -> fits.BinTableHDU:
    """EPSF extension on an nx × ny zone grid of the 2040² detector; stamp(ix, iy) -> ePSF."""
    zones = [(ix, iy) for iy in range(ny) for ix in range(nx)]  # x fast, then y
    width = (2040 / nx, 2040 / ny)
    stamps = np.array([stamp(*z) for z in zones])
    n = stamps.shape[1]
    hdu = fits.BinTableHDU.from_columns(
        [
            fits.Column("BINX", "J", array=[ix for ix, _ in zones]),
            fits.Column("BINY", "J", array=[iy for _, iy in zones]),
            fits.Column("XCENTER", "E", array=[(ix + 0.5) * width[0] - 0.5 for ix, _ in zones]),
            fits.Column("YCENTER", "E", array=[(iy + 0.5) * width[1] - 0.5 for _, iy in zones]),
            fits.Column("XWIDTH", "E", array=[width[0]] * len(zones)),
            fits.Column("YWIDTH", "E", array=[width[1]] * len(zones)),
            fits.Column("NSTAR", "J", array=[400] * len(zones)),
            fits.Column("NEFF_MEAN", "E", array=[5.0] * len(zones)),
            fits.Column("CWAVE", "E", array=[4.7] * len(zones)),
            fits.Column("CBAND", "E", array=[0.04] * len(zones)),
            fits.Column("EPSF", f"{n * n}D", dim=f"({n},{n})", array=stamps),
        ],
        name="EPSF",
    )
    hdu.header["OVSMPX"] = hdu.header["OVSMPY"] = ov
    return hdu


def _cutout(tmp_path, image, table=None, variance=0.04):
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [(SIZE + 1) / 2, (SIZE + 1) / 2]
    wcs.wcs.cdelt = [-SCALE_DEG, SCALE_DEG]
    header = wcs.to_header()
    # Cutout pixel 0 is detector pixel 1001 in x and 501 in y.
    header.update(CRPIX1A=-1000.0, CRPIX2A=-500.0, CRVAL1A=0.0, CRVAL2A=0.0)
    hdus = [
        fits.PrimaryHDU(),
        fits.ImageHDU(image.astype(np.float32), header, name="IMAGE"),
        fits.ImageHDU(np.full(image.shape, variance, np.float32), name="VARIANCE"),
    ]
    if table is not None:
        hdus.append(table)
    path = tmp_path / "cutout.fits"
    fits.HDUList(hdus).writeto(path, overwrite=True)
    return path


SPHEREX_LIKE = psf.EPSF(pixel_gaussian(0.55, 0.55), (5, 5))  # FWHM 1.3 px like the D6 zones


@pytest.mark.parametrize(("x0", "y0"), [(20.0, 20.0), (20.3, 19.6)])
def test_point_source_is_the_sampled_epsf_and_sums_to_one(x0, y0):
    image = psf.pixel_psf(SPHEREX_LIKE, x0, y0, (SIZE, SIZE))

    yy, xx = np.indices(image.shape)
    pixels = (ndtr((xx + 0.5 - x0) / 0.55) - ndtr((xx - 0.5 - x0) / 0.55)) * (
        ndtr((yy + 0.5 - y0) / 0.55) - ndtr((yy - 0.5 - y0) / 0.55)
    )
    assert image.sum() == pytest.approx(1.0, abs=1e-12)
    # Sampled, not integrated again: the exact pixel integrals of the Gaussian come back.
    np.testing.assert_allclose(image, pixels / pixels.sum(), atol=3e-3 * pixels.max())


def test_epsf_is_interpolated_between_zone_centres_without_swapping_axes():
    table = epsf_table(lambda ix, iy: pixel_gaussian(0.5 + 0.1 * ix, 0.6 + 0.2 * iy))

    at_centre = psf.epsf_at(table, 1529.5, 1699.5)
    halfway = psf.epsf_at(table, 1019.5, 339.5)

    np.testing.assert_allclose(at_centre.data, pixel_gaussian(0.6, 1.0), atol=1e-12)
    expected = (pixel_gaussian(0.5, 0.6) + pixel_gaussian(0.6, 0.6)) / 2
    np.testing.assert_allclose(halfway.data, expected, atol=1e-12)


@pytest.mark.parametrize("offset_px", [0.0, 0.3])
def test_aperture_correction_of_a_gaussian_matches_the_analytic_value(tmp_path, offset_px):
    # Well sampled (σ = 3 px, r = 6 px): the pixelised aperture then holds the analytic encircled
    # energy 1 − exp(−r²/2σ²). The archive's 1.3 px ePSFs are tested below on a total flux.
    d = (np.arange(81) - 40) / 2
    g = np.outer(np.exp(-(d**2) / 18), np.exp(-(d**2) / 18))
    table = epsf_table(lambda ix, iy: g / g.sum(), ov=2)
    path = _cutout(tmp_path, np.zeros((SIZE, SIZE)), table)
    ra = RA - offset_px * SCALE_DEG / np.cos(np.radians(DEC))

    correction = aperture_correction(path, ra, DEC, radius_px=6.0)

    assert 1 / correction == pytest.approx(1 - math.exp(-36 / 18), rel=5e-3)


@pytest.mark.parametrize("offset_px", [0.0, 0.3, 0.5])
def test_corrected_aperture_flux_is_the_total_flux_of_a_spherex_like_star(tmp_path, offset_px):
    x0 = SIZE // 2 + offset_px
    yy, xx = np.indices((SIZE, SIZE))
    star = (
        90.0
        * (ndtr((xx + 0.5 - x0) / 0.55) - ndtr((xx - 0.5 - x0) / 0.55))
        * (ndtr((yy + 0.5 - SIZE // 2) / 0.55) - ndtr((yy - 0.5 - SIZE // 2) / 0.55))
    )
    path = _cutout(tmp_path, star + 3.0, epsf_table(lambda ix, iy: pixel_gaussian(0.55, 0.55)))
    ra = RA - offset_px * SCALE_DEG / np.cos(np.radians(DEC))

    flux, _, _ = forced_photometry(path, ra, DEC)
    correction = aperture_correction(path, ra, DEC)

    assert 1.005 < correction < 1.02  # r = 2 px holds ~99 % of this ePSF
    # Integrating the ePSF over pixels once more would overshoot by 1.2 %.
    assert flux * correction == pytest.approx(90.0 * UJY_PER_MJY_SR, rel=2e-3)


@pytest.mark.parametrize("x_px", [39.0, 40.5, 42.5, 45.0])
def test_a_target_whose_aperture_leaves_the_cutout_gets_no_correction(tmp_path, x_px):
    table = epsf_table(lambda ix, iy: pixel_gaussian(0.55, 0.55))
    path = _cutout(tmp_path, np.ones((SIZE, SIZE)), table)
    ra = RA - (x_px - SIZE // 2) * SCALE_DEG / np.cos(np.radians(DEC))

    assert forced_photometry(path, ra, DEC) == SKIP_EDGE
    assert aperture_correction(path, ra, DEC) is None


def test_cutout_without_epsf_gives_no_psf_and_no_correction(tmp_path):
    path = _cutout(tmp_path, np.zeros((SIZE, SIZE)))

    assert psf.psf_at(path, RA, DEC) is None
    assert aperture_correction(path, RA, DEC) is None


def test_psf_photometry_has_a_better_snr_than_the_aperture(tmp_path):
    table = epsf_table(lambda ix, iy: pixel_gaussian(0.55, 0.55))
    path = _cutout(tmp_path, np.zeros((SIZE, SIZE)), table, variance=1.0)
    point = psf.psf_at(path, RA, DEC)
    yy, xx = np.indices(point.shape)
    weights = _aperture_weights(xx - SIZE // 2, yy - SIZE // 2, 2.0)
    correction = aperture_correction(path, RA, DEC)
    rng = np.random.default_rng(3)
    variance = np.ones(point.shape)
    aperture, fitted, errors = [], [], []
    for _ in range(400):
        image = 40.0 * point + 5.0 + rng.normal(0, 1, point.shape)
        aperture.append(np.sum(weights * (image - 5.0)) * correction)
        f, e = psf.psf_flux(image, variance, 5.0, point)
        fitted.append(f)
        errors.append(e)

    assert np.mean(fitted) == pytest.approx(40.0, abs=3 * np.std(fitted) / 20)
    assert np.mean(aperture) == pytest.approx(40.0, abs=3 * np.std(aperture) / 20)
    assert np.std(fitted) == pytest.approx(errors[0], rel=0.1)
    assert np.std(fitted) < 0.8 * np.std(aperture)


def test_the_shared_psf_code_is_the_same_as_in_the_analysis_service():
    # The api image holds the backend only; the CI checkout (CI=true) must hold both.
    if not ANALYSIS_PSF.exists() and not os.environ.get("CI"):
        pytest.skip("analysis-service is not in this checkout")

    ours, theirs = (_definitions(path) for path in (Path(psf.__file__), ANALYSIS_PSF))

    assert [name for name in SHARED if ours[name] != theirs[name]] == []


def _definitions(path: Path) -> dict[str, str]:
    tree = ast.parse(path.read_text())
    return {
        node.name: ast.dump(node)
        for node in tree.body
        if isinstance(node, ast.FunctionDef | ast.ClassDef)
    }
