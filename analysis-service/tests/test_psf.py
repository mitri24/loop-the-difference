"""SPHEREx ePSF: pixels, aperture correction, grid PSF and ZOGY (no network).

The ePSF tables are synthetic but built like the archive's EPSF extension (checked on real
DR1 D6 cutouts): one row per zone, XCENTER/YCENTER in 0-based detector pixels, a 33 × 33
float64 ePSF oversampled 5 × 5 that sums to 1, OVSMPX/OVSMPY in the header."""

import asyncio
import dataclasses
import io
import math
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from scipy.special import ndtr

from app import analysis, cutouts, imaging, psf
from app.schemas import Observation, Target
from app.spectral import WaveTable

from .conftest import make_frame, star_field, tan_wcs
from .test_pipeline_offline import STARS, _stored

RA, DEC = 133.795, -7.245
WAVE = WaveTable(
    6,
    np.array([1.0, 2040.0]),
    np.array([1.0, 2040.0]),
    np.full((2, 2), 4.7),
    np.full((2, 2), 0.04),
    "test",
)


def pixel_gaussian(sx: float, sy: float, ov: int = 5, n: int = 33) -> np.ndarray:
    """ePSF of a Gaussian PSF: integrated over one detector pixel, sampled ov times per pixel."""
    d = (np.arange(n) - (n - 1) / 2) / ov
    e = np.outer(
        ndtr((d + 0.5) / sy) - ndtr((d - 0.5) / sy), ndtr((d + 0.5) / sx) - ndtr((d - 0.5) / sx)
    )
    return e / e.sum()


def epsf_table(sigma, nx: int = 2, ny: int = 3) -> fits.BinTableHDU:
    """EPSF extension on an nx × ny zone grid of the 2040² detector; sigma(ix, iy) -> (σx, σy)."""
    zones = [(ix, iy) for iy in range(ny) for ix in range(nx)]  # x fast, then y
    width = (2040 / nx, 2040 / ny)
    column = lambda name, fmt, values, **kw: fits.Column(name, fmt, array=values, **kw)  # noqa: E731
    hdu = fits.BinTableHDU.from_columns(
        [
            column("BINX", "J", [ix for ix, _ in zones]),
            column("BINY", "J", [iy for _, iy in zones]),
            column("XCENTER", "E", [(ix + 0.5) * width[0] - 0.5 for ix, _ in zones], unit="pixel"),
            column("YCENTER", "E", [(iy + 0.5) * width[1] - 0.5 for _, iy in zones], unit="pixel"),
            column("XWIDTH", "E", [width[0]] * len(zones), unit="pixel"),
            column("YWIDTH", "E", [width[1]] * len(zones), unit="pixel"),
            column("NSTAR", "J", [400] * len(zones)),
            column("NEFF_MEAN", "E", [5.0] * len(zones)),
            column("CWAVE", "E", [4.7] * len(zones), unit="um"),
            column("CBAND", "E", [0.04] * len(zones), unit="um"),
            column(
                "EPSF",
                "1089D",
                np.array([pixel_gaussian(*sigma(*z)) for z in zones]),
                dim="(33,33)",
            ),
        ],
        name="EPSF",
    )
    hdu.header["OVSMPX"] = hdu.header["OVSMPY"] = 5
    return hdu


def synthetic_cutout(image, model=None, wcs=None, variance=1e-4) -> cutouts.Cutout:
    return cutouts.Cutout(
        path=Path("synthetic.fits"),
        image=image.astype(np.float32),
        flags=np.zeros(image.shape, np.int64),
        variance=np.full(image.shape, variance, np.float32),
        zodi=np.zeros(image.shape, np.float32),
        wcs=wcs or tan_wcs(RA, DEC, image.shape[0], 6.15),
        header=fits.Header({"MJD-AVG": 60900.0}),
        raw_offset=(1000.0, 500.0),
        wave=WAVE,
        psf=model,
    )


SPHEREX_LIKE = psf.EPSF(pixel_gaussian(0.55, 0.55), (5, 5))  # FWHM 1.3 px like the D6 zones


@pytest.mark.parametrize(("x0", "y0"), [(20.0, 20.0), (20.3, 19.6), (20.5, 20.5)])
def test_point_source_is_the_sampled_epsf_and_sums_to_one(x0, y0):
    image = psf.pixel_psf(SPHEREX_LIKE, x0, y0, (41, 41))

    yy, xx = np.indices(image.shape)
    pixels = (ndtr((xx + 0.5 - x0) / 0.55) - ndtr((xx - 0.5 - x0) / 0.55)) * (
        ndtr((yy + 0.5 - y0) / 0.55) - ndtr((yy - 0.5 - y0) / 0.55)
    )
    assert image.sum() == pytest.approx(1.0, abs=1e-12)
    # Sampled, not integrated again: the exact pixel integrals of the Gaussian come back.
    np.testing.assert_allclose(image, pixels / pixels.sum(), atol=3e-3 * pixels.max())
    # Centred on the first column, it keeps the part right of that pixel's left edge.
    clipped = psf.pixel_psf(SPHEREX_LIKE, 0.0, y0, (41, 41)).sum()
    assert clipped == pytest.approx(ndtr(0.5 / 0.55), abs=2e-3)


def test_epsf_is_interpolated_between_zone_centres_without_swapping_axes():
    table = epsf_table(lambda ix, iy: (0.5 + 0.1 * ix, 0.6 + 0.2 * iy))
    x_centres, y_centres = (509.5, 1529.5), (339.5, 1019.5, 1699.5)

    at_centre = psf.epsf_at(table, x_centres[1], y_centres[2])
    halfway = psf.epsf_at(table, sum(x_centres) / 2, y_centres[0])
    beyond_edge = psf.epsf_at(table, 0.0, 2039.0)

    assert at_centre.oversampling == (5, 5)
    np.testing.assert_allclose(at_centre.data, pixel_gaussian(0.6, 1.0), atol=1e-12)
    expected = (pixel_gaussian(0.5, 0.6) + pixel_gaussian(0.6, 0.6)) / 2
    np.testing.assert_allclose(halfway.data, expected, atol=1e-12)
    np.testing.assert_allclose(beyond_edge.data, pixel_gaussian(0.5, 1.0), atol=1e-12)


@pytest.mark.parametrize(("x0", "y0"), [(20.0, 20.0), (20.3, 20.4)])
def test_aperture_correction_of_a_gaussian_matches_the_analytic_value(monkeypatch, x0, y0):
    # Well sampled (σ = 3 px, r = 6 px): the pixelised aperture then holds the analytic encircled
    # energy 1 − exp(−r²/2σ²). The archive's 1.3 px ePSFs are tested below on a total flux.
    monkeypatch.setattr(analysis, "APERTURE_PX", 6.0)
    monkeypatch.setattr(analysis, "ANNULUS_PX", (14.0, 18.0))
    d = (np.arange(81) - 40) / 2
    g = np.exp(-(d**2) / 18)
    model = psf.EPSF(np.outer(g, g) / np.outer(g, g).sum(), (2, 2))
    cut = synthetic_cutout(50 * psf.pixel_psf(model, x0, y0, (41, 41)), model)

    *_, correction = analysis.aperture_flux(cut, *cut.wcs.pixel_to_world_values(x0, y0))

    assert 1 / correction == pytest.approx(1 - math.exp(-36 / 18), rel=5e-3)


@pytest.mark.parametrize("x0", [20.0, 20.3, 20.5])
def test_corrected_aperture_flux_is_the_total_flux_of_a_spherex_like_star(x0):
    yy, xx = np.indices((41, 41))
    star = (
        80.0
        * (ndtr((xx + 0.5 - x0) / 0.55) - ndtr((xx - 0.5 - x0) / 0.55))
        * (ndtr((yy + 0.5 - 20.2) / 0.55) - ndtr((yy - 0.5 - 20.2) / 0.55))
    )
    cut = synthetic_cutout(star, SPHEREX_LIKE)

    flux, *_, correction = analysis.aperture_flux(cut, *cut.wcs.pixel_to_world_values(x0, 20.2))

    total_mjy = 80.0 * cut.pixel_solid_angle_sr * 1e9
    assert 1.005 < correction < 1.02  # r = 2 px holds ~99 % of this ePSF
    # Integrating the ePSF over pixels once more would overshoot by 1.2 %.
    assert flux * correction == pytest.approx(total_mjy, rel=2e-3)


def _response(table: fits.BinTableHDU | None, size: int = 25) -> bytes:
    header = tan_wcs(RA, DEC, size, 6.15).to_header()
    header.update(CRPIX1A=-1000.0, CRPIX2A=-500.0, CRVAL1A=0.0, CRVAL2A=0.0, DETECTOR=6)
    plane = np.zeros((size, size), np.float32)
    wave = fits.BinTableHDU.from_columns(
        [
            fits.Column("X", "2J", array=[[1, 2040]]),
            fits.Column("Y", "2J", array=[[1, 2040]]),
            fits.Column("VALUES", "8E", array=[np.full(8, 4.7)]),
        ],
        name="WCS-WAVE",
    )
    hdus = [
        fits.PrimaryHDU(),
        fits.ImageHDU(plane, header, name="IMAGE"),
        fits.ImageHDU(plane.astype(np.int32), name="FLAGS"),
        fits.ImageHDU(plane + 1e-4, name="VARIANCE"),
        fits.ImageHDU(plane, name="ZODI"),
        *([table] if table is not None else []),
        wave,
    ]
    buffer = io.BytesIO()
    fits.HDUList(hdus).writeto(buffer)
    return buffer.getvalue()


def test_cached_cutout_keeps_only_the_epsf_at_the_target(tmp_path):
    table = epsf_table(lambda ix, iy: (0.5 + 0.1 * ix, 0.6 + 0.2 * iy))
    content = _response(table)
    path = tmp_path / "cutout.fits"

    cutouts._strip_and_save(content, path, RA, DEC)

    with fits.open(path) as hdul:
        assert "EPSF" not in hdul and hdul["PSF"].data.shape == (33, 33)
        assert hdul[0].header["CACHEVER"] == cutouts.CACHE_VERSION
    assert path.stat().st_size < len(content)
    cut = cutouts.load_cutout(path)
    # Cutout centre (12, 12) lies on detector pixel (12 + 1001, 12 + 501).
    expected = psf.epsf_at(table, 1013.0, 513.0)
    assert cut.psf.oversampling == (5, 5)
    np.testing.assert_allclose(cut.psf.data, expected.data, rtol=1e-6, atol=1e-9)
    assert cutouts._cached(path)


def test_cutout_without_epsf_is_cached_without_psf_and_old_caches_are_fetched_again(tmp_path):
    path = tmp_path / "cutout.fits"
    cutouts._strip_and_save(_response(None), path, RA, DEC)
    old = tmp_path / "old.fits"
    fits.PrimaryHDU().writeto(old)

    assert cutouts.load_cutout(path).psf is None
    assert cutouts._cached(path)
    assert not cutouts._cached(old)
    assert not cutouts._cached(tmp_path / "missing.fits")


@pytest.mark.asyncio
async def test_an_old_cached_cutout_is_fetched_again_and_kept_while_the_archive_fails(monkeypatch):
    url = "https://irsa.example/level2.fits"
    path = cutouts.settings.cutout_cache / f"{cutouts.cache_key(url, RA, DEC, 0.01)}.fits"
    cutouts._strip_and_save(_response(None), path, RA, DEC)
    with fits.open(path, mode="update") as hdul:
        del hdul[0].header["CACHEVER"]  # as cached before the ePSF was kept

    async def no_wait(seconds):
        return None

    monkeypatch.setattr(cutouts.asyncio, "sleep", no_wait)
    semaphore = asyncio.Semaphore(1)
    table = epsf_table(lambda ix, iy: (0.55, 0.55))
    answers = {"busy": httpx.Response(503), "back": httpx.Response(200, content=_response(table))}
    found = {}
    for state, answer in answers.items():
        transport = httpx.MockTransport(lambda request, answer=answer: answer)
        async with httpx.AsyncClient(transport=transport) as client:
            found[state] = await cutouts.fetch_cutout(client, semaphore, url, RA, DEC, 0.01)
        found[state + " psf"] = cutouts.load_cutout(path).psf

    assert found["busy"] == found["back"] == path
    assert found["busy psf"] is None and found["back psf"] is not None


def _principal_angle(stamp: np.ndarray) -> float:
    yy, xx = np.indices(stamp.shape) - stamp.shape[0] // 2
    ixx, iyy, ixy = (np.sum(stamp * m) for m in (xx * xx, yy * yy, xx * yy))
    return math.degrees(0.5 * math.atan2(2 * ixy, ixx - iyy)) % 180


@pytest.mark.parametrize("rotation", [0.0, 20.0, 65.0])
def test_grid_psf_is_what_the_alignment_does_to_a_star(rotation):
    model = psf.EPSF(pixel_gaussian(0.45, 0.8), (5, 5))  # long along the detector's y axis
    grid = imaging.make_grid(RA, DEC, 8.0)
    wcs = tan_wcs(RA, DEC, 121, 6.15, rot_deg=rotation)
    stamp = imaging.grid_psf(synthetic_cutout(np.zeros((121, 121)), model, wcs), grid)
    # Independent stars on other grid pixels, resampled by align itself.
    image, centres = np.zeros((121, 121)), []
    for gx in range(12, 68, 9):
        for gy in range(12, 68, 9):
            x, y = wcs.world_to_pixel_values(*grid.wcs.pixel_to_world_values(gx, gy))
            image += psf.pixel_psf(model, float(x), float(y), image.shape)
            centres.append((gx, gy))
    aligned = imaging.align(synthetic_cutout(image, model, wcs), grid).image
    measured = np.mean([aligned[y - 5 : y + 6, x - 5 : x + 6] for x, y in centres], axis=0)

    assert stamp.sum() == pytest.approx(1.0)
    assert np.abs(measured / measured.sum() - stamp).max() < 0.03 * stamp.max()
    # The detector's y axis points along the grid's y axis turned by the rotation.
    tip = wcs.pixel_to_world_values(60.0, 61.0)
    gx, gy = grid.wcs.world_to_pixel_values(*tip)
    axis = math.degrees(math.atan2(gy - grid.npix // 2, gx - grid.npix // 2)) % 180
    assert abs((_principal_angle(stamp) - axis + 90) % 180 - 90) < 3


def _frame(image, grid, fwhm, **meta):
    frame = _stored(image, grid, **meta)
    frame.psf = _gaussian_stamp(fwhm)
    return frame


def _gaussian_stamp(fwhm: float, size: int = 11) -> np.ndarray:
    yy, xx = np.indices((size, size)) - size // 2
    g = np.exp(-(xx**2 + yy**2) / (2 * (fwhm / 2.3548) ** 2))
    return g / g.sum()


def _field(grid, stars, fwhm, seed):
    """Stars of the given total fluxes, drawn with a Gaussian PSF of this FWHM."""
    norm = _gaussian_stamp(fwhm, 21).max()
    return star_field(grid, [(x, y, f * norm) for x, y, f in stars], fwhm_px=fwhm, seed=seed)


async def _no_sources(*args, **kw):
    return []


FLUX = [(x, y, 10 * a) for x, y, a in STARS]


@pytest.mark.asyncio
async def test_zogy_finds_a_transient_between_frames_with_different_psfs(monkeypatch):
    monkeypatch.setattr(analysis, "gaia_cone", _no_sources)
    monkeypatch.setattr(analysis, "allwise_cone", _no_sources)
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _frame(_field(grid, [*FLUX, (30, 40, 1.0)], 1.6, 11), grid, 1.6, id="j" * 20)
    b = _frame(_field(grid, FLUX, 2.4, 12), grid, 2.4, id="k" * 20, mjd=61270.0, visit=1)
    analysis.FRAMES.put(a.meta.id, a)
    analysis.FRAMES.put(b.meta.id, b)

    res = await analysis.difference(a.meta.id, b.meta.id, force=False)

    assert res.significance_method == "zogy"
    assert [c.title for c in res.checks if c.code == "difference_method"] == [
        "Significance: PSF-matched difference (ZOGY)"
    ]
    (transient,) = res.residuals
    assert transient.significance > 5
    assert (round(transient.x), round(transient.y)) == (30, grid.npix - 1 - 40)


@pytest.mark.asyncio
async def test_a_star_whose_psf_changed_leaves_no_residual_with_zogy_but_with_the_direct_method(
    monkeypatch,
):
    monkeypatch.setattr(analysis, "gaia_cone", _no_sources)
    monkeypatch.setattr(analysis, "allwise_cone", _no_sources)
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    image_a, image_b = _field(grid, FLUX, 1.6, 13), _field(grid, FLUX, 2.4, 14)
    a = _frame(image_a, grid, 1.6, id="l" * 20)
    b = _frame(image_b, grid, 2.4, id="m" * 20, mjd=61270.0, visit=1)
    a0 = _stored(image_a, grid, id="n" * 20)
    b0 = _stored(image_b, grid, id="o" * 20, mjd=61270.0, visit=1)
    for frame in (a, b, a0, b0):
        analysis.FRAMES.put(frame.meta.id, frame)

    zogy = await analysis.difference(a.meta.id, b.meta.id, force=False)
    direct = await analysis.difference(a0.meta.id, b0.meta.id, force=False)

    assert zogy.residuals == []
    # Gegenprobe: the same frames without PSF matching flag the stars.
    assert direct.significance_method == "direct"
    assert any(c.code == "psf_unavailable" for c in direct.checks)
    at_stars = {(x, grid.npix - 1 - y) for x, y, _ in STARS}
    flagged = {(round(r.x), round(r.y)) for r in direct.residuals if abs(r.significance) > 5}
    assert len(flagged & at_stars) >= 4
    # Without the 5 % floor too: the PSF matching itself removes the star.
    score = psf.zogy(image_a, image_b, a.variance, b.variance, a.psf, b.psf)
    assert np.abs(score).max() < 5


TRANSIENT_PX = (20.4, 55.7)


def _aligned_pair(rotations, seed, transient=0.0):
    """A and B as the pipeline makes them: 40 stars of 0.3-40 (noise 0.02/px) drawn with
    different elliptical ePSFs on cutouts at these rotations, aligned onto one grid, each with
    its grid_psf. A transient of `transient` lies at TRANSIENT_PX in A only, 6 px from any star:
    on a bright star the 5 % floor hides it, as it hides the star."""
    grid = imaging.make_grid(RA, DEC, 8.0)
    rng = np.random.default_rng(seed)
    stars = rng.uniform(8, grid.npix - 8, (80, 2))
    stars = stars[np.hypot(*(stars - TRANSIENT_PX).T) > 6][:40]
    fluxes = 10 ** rng.uniform(-0.5, 1.6, len(stars))
    pairs = zip(stars, fluxes, strict=True)
    sky = [(*grid.wcs.pixel_to_world_values(x, y), f) for (x, y), f in pairs]
    sigmas = ((0.5, 0.6), (0.65, 0.55))
    frames = []
    for k, (rotation, sigma) in enumerate(zip(rotations, sigmas, strict=True)):
        model = psf.EPSF(pixel_gaussian(*sigma), (5, 5))
        wcs = tan_wcs(RA, DEC, 121, 6.15, rot_deg=rotation)
        image = np.random.default_rng(seed + k + 1).normal(0, 0.02, (121, 121))
        extra = [(*grid.wcs.pixel_to_world_values(*TRANSIENT_PX), transient)] if k == 0 else []
        for ra, dec, flux in sky + extra:
            x, y = wcs.world_to_pixel_values(ra, dec)
            image += flux * psf.pixel_psf(model, float(x), float(y), image.shape)
        cut = synthetic_cutout(image, model, wcs, variance=0.02**2)
        al = imaging.align(cut, grid)
        meta = make_frame(id=f"e2e{seed:03d}{k}".ljust(20, "x"), mjd=60900.0 + 370 * k, visit=k)
        target = Target(ra=RA, dec=DEC)
        stamp = imaging.grid_psf(cut, grid)
        frames.append(
            analysis.StoredFrame(
                meta, al.image, al.variance, al.hard_mask, al.flags, grid, target, {}, stamp
            )
        )
    return *frames, stars


def _at_stars(residuals, stars, npix) -> int:
    return sum(
        np.hypot(*(stars - (r.x, npix - 1 - r.y)).T).min() < 3 for r in residuals
    )  # display y runs downwards


@pytest.mark.asyncio
@pytest.mark.parametrize(("rotations", "seed"), [((20, 140), 1), ((65, 200), 2), ((170, 355), 3)])
async def test_after_alignment_zogy_cancels_stars_at_any_rotation_and_finds_the_transient(
    monkeypatch, rotations, seed
):
    monkeypatch.setattr(analysis, "gaia_cone", _no_sources)
    monkeypatch.setattr(analysis, "allwise_cone", _no_sources)
    a, b, stars = _aligned_pair(rotations, seed, transient=1.0)
    plain = [
        dataclasses.replace(f, psf=None, meta=f.meta.model_copy(update={"id": f"{f.meta.id}d"}))
        for f in (a, b)
    ]
    for frame in (a, b, *plain):
        analysis.FRAMES.put(frame.meta.id, frame)

    zogy = await analysis.difference(a.meta.id, b.meta.id, force=False)
    direct = await analysis.difference(plain[0].meta.id, plain[1].meta.id, force=False)

    npix = a.grid.npix
    assert zogy.significance_method == "zogy" and _at_stars(zogy.residuals, stars, npix) == 0
    (transient,) = zogy.residuals
    assert transient.significance > 5
    assert abs(transient.x - TRANSIENT_PX[0]) <= 1
    assert abs(npix - 1 - transient.y - TRANSIENT_PX[1]) <= 1
    assert _at_stars(direct.residuals, stars, npix) >= 10


def _peaks(score, bad):
    return analysis._find_residual_peaks(score, bad | ~np.isfinite(score))


def test_without_the_floor_the_resampled_psf_leaves_star_residuals():
    # Why S_corr keeps a floor: the resampled PSF changes from star to star with the sub-pixel
    # position, which one PSF per frame cannot match.
    a, b, stars = _aligned_pair((20, 140), 1)
    bad = a.hard_mask | b.hard_mask
    image_a, image_b = (np.where(bad, 0.0, np.nan_to_num(f.image)) for f in (a, b))
    var_a, var_b = (analysis._filled(f.variance, bad) for f in (a, b))

    peaks = [
        _peaks(psf.zogy(image_a, image_b, var_a, var_b, a.psf, b.psf, floor=floor), bad)
        for floor in (0.0, analysis.SYSTEMATIC_FRACTION)
    ]

    near = [sum(np.hypot(*(stars - (x, y)).T).min() < 3 for x, y, _ in p) for p in peaks]
    assert near[0] >= 3 and near[1] == 0


def test_registration_noise_is_the_scatter_of_single_stars_or_a_conservative_guess():
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _stored(star_field(grid, STARS, seed=1), grid)
    b = _stored(star_field(grid, STARS, seed=2, shift=(0.3, -0.2)), grid, mjd=61200.0)
    _, _, err, n = analysis.measure_offset(a, b)
    empty = _stored(np.zeros((grid.npix, grid.npix)), grid)

    assert analysis.register(a, b)[2] == pytest.approx(err * math.sqrt(n / 2))
    assert analysis.register(empty, empty)[2] == analysis.UNMEASURED_REGISTRATION_PX


@pytest.mark.asyncio
async def test_spectrum_is_corrected_to_total_flux_only_when_every_exposure_has_an_epsf(
    monkeypatch,
):
    star = 80.0 * psf.pixel_psf(SPHEREX_LIKE, 20.0, 20.0, (41, 41))
    with_psf, without = synthetic_cutout(star, SPHEREX_LIKE), synthetic_cutout(star)
    obs = [
        Observation(
            obs_publisher_did=f"d{i}",
            obs_id=f"o{i}",
            collection="spherex_dr1",
            band="D6",
            detector=6,
            mjd=60900.0 + i,
            date_utc="x",
            exptime_s=100,
            access_url=f"u{i}",
            s_region="",
            em_min_um=4.4,
            em_max_um=5.0,
            resolving_power=130,
            lambda_est_um=4.7,
            visit=0,
        )
        for i in range(2)
    ]

    async def found(*args):
        return obs, [], [], None

    monkeypatch.setattr(analysis, "find_observations", found)
    monkeypatch.setattr(analysis, "search_checks", lambda o, v: [])
    results = {}
    for pair in ((with_psf, with_psf), (with_psf, without)):

        async def downloaded(selected, *args, pair=pair):
            return list(zip(obs, pair, strict=True)), []

        monkeypatch.setattr(analysis, "download_all", downloaded)
        target = Target(ra=RA, dec=DEC)
        results[pair[1] is with_psf] = await analysis.run_spectrum(target, 10, lambda p, m: None)

    corrected, mixed = results[True], results[False]
    assert corrected.aperture_corrected and not mixed.aperture_corrected
    raw = mixed.points[0].flux_mjy
    assert [p.flux_mjy for p in mixed.points] == pytest.approx([raw, raw])
    assert [p.flux_mjy for p in corrected.points] == pytest.approx([raw * 1.0105] * 2, rel=5e-3)
    assert "1 exposure(s) came without an ePSF" in _method(mixed).detail
    assert "corrected to total flux" in _method(corrected).title


def _method(result):
    (check,) = [c for c in result.checks if c.code == "spectrum_method"]
    return check
