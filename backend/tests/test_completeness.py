"""Measured detection limit: artificial stars set into synthetic frames of known noise (no network,
no files but tmp_path)."""

import json
import math
from pathlib import Path

import numpy as np
import pytest
from astropy.stats import gaussian_fwhm_to_sigma
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_area
from scipy.optimize import brentq
from scipy.special import ndtr

from app import completeness, sources, tasks
from app.completeness import (
    CLEARANCE_PX,
    EDGE_PX,
    LEVELS_SIGMA,
    SEPARATION_PX,
    STARS_PER_LEVEL,
    Measured,
    _allowed,
    _epsf_stars,
    _flux_at,
    _gaussian_stars,
    _monotonic,
    _near,
    _positions,
    completeness_checks,
    default_pair,
    measure,
    measure_completeness,
)
from app.frames import SPHEREX_PIXEL_SCALE_ARCSEC, Aligned, target_grid
from app.models import Completeness, Frame, FrameManifest, Observation
from app.psf import EPSF
from app.sources import FWHM_PX, PSF, SKY_BOX_PX, THRESHOLD_SIGMA, detect
from app.tasks import build_frames

RA, DEC, SIZE_DEG = 133.795, -7.245, 0.1
GRID, SHAPE = target_grid(RA, DEC, SIZE_DEG)
# µJy of 1 MJy/sr over one grid pixel.
UJY = proj_plane_pixel_area(GRID) * 1e12 * (math.pi / 180) ** 2
MATCH_RADIUS_ARCSEC = completeness.MATCH_RADIUS_PX * SPHEREX_PIXEL_SCALE_ARCSEC


def _noise(seed: int) -> Aligned:
    """Unit Gaussian noise with a matching VARIANCE plane: a frame of known depth."""
    image = np.random.default_rng(seed).normal(0.0, 1.0, SHAPE)
    return Aligned(image, np.ones(SHAPE), np.ones(SHAPE, dtype=bool))


def _theory_flux(share: float) -> float:
    """Total flux (µJy) of a FWHM_PX Gaussian star that passes the detection threshold at `share`
    of random sub-pixel positions: its expected S/N at the nearest pixel of the detection's S/N
    map (unit noise), less what the 11 px median sky takes (a faint star lifts the median by
    about its flux over the 121 pixels); the measured S/N scatters by 1 around it."""
    k = np.arange(-2, 3)
    sigma = FWHM_PX * gaussian_fwhm_to_sigma

    def pixels(offset: float) -> np.ndarray:
        return ndtr((k + 0.5 - offset) / sigma) - ndtr((k - 0.5 - offset) / sigma)

    offsets = (np.arange(20) + 0.5) / 20 - 0.5
    norm = np.sqrt(np.sum(PSF**2))
    snr = np.array([np.sum(np.outer(pixels(b), pixels(a)) * PSF) for a in offsets for b in offsets])
    snr = (snr - PSF.sum() / SKY_BOX_PX**2) / norm
    return brentq(lambda flux: ndtr(flux * snr - THRESHOLD_SIGMA).mean() - share, 1, 100) * UJY


@pytest.mark.parametrize("seed", [1, 2])
def test_half_the_stars_are_found_where_the_5_sigma_threshold_expects_it(seed):
    result = measure(_noise(seed), _gaussian_stars(GRID, SHAPE), np.random.default_rng(seed))

    limit = result.limit
    assert limit.injected == sum(result.injected) == len(LEVELS_SIGMA) * STARS_PER_LEVEL
    # 20 stars per step scatter the share found by 0.11 at 50 %: over 20 noise fields the 50 % and
    # 90 % fluxes came out 2 % ± 5 % above the theory, so 3σ is 15 %.
    assert limit.flux50_ujy == pytest.approx(_theory_flux(0.5), rel=0.15)
    assert limit.flux90_ujy == pytest.approx(_theory_flux(0.9), rel=0.15)
    assert limit.ab50 == pytest.approx(23.9 - 2.5 * math.log10(limit.flux50_ujy), abs=0.01)
    assert limit.ab90 < limit.ab50
    # The 1σ of a PSF fit to unit noise, 1 / √ΣP² for the unit-flux star P (over 40 noise fields
    # 3 % ± 4 % below: the local sky takes some of the noise).
    star = _gaussian_stars(GRID, SHAPE)(np.array([29.0]), np.array([29.0]), np.array([UJY]))
    assert limit.noise_ujy == pytest.approx(UJY / np.sqrt(np.sum(star**2)), rel=0.15)
    assert result.found[0] <= 2 and result.found[-1] == STARS_PER_LEVEL
    assert limit.false_per_frame == 0  # 5σ noise peaks are rarer than one in 1000 such frames
    assert 0 < limit.offset_arcsec < MATCH_RADIUS_ARCSEC


def _frame(index: int, epoch: int, mjd: float, wavelength_um: float | None = None) -> Frame:
    return Frame(
        index=index,
        url=f"/f/{index}.png",
        obs_id=f"obs-{index}",
        date="2026-03-10T12:00:00Z",
        mjd=mjd,
        detector=3,
        wavelength_min_um=1.6,
        wavelength_max_um=1.7,
        coverage=1.0,
        source_url="https://irsa.example/obs",
        epoch=epoch,
        wavelength_um=wavelength_um,
    )


def test_a_job_sets_the_same_stars_every_time_another_job_other_ones(monkeypatch):
    monkeypatch.setattr(completeness, "cutout_epsf", lambda path, ra, dec: None)

    def run(key: str) -> Completeness:
        (frame,) = frames = [_frame(0, 0, 61000.0)]
        measure_completeness(key, frames, [_noise(3)], [Path("cutout.fits")], GRID)
        return frame.completeness

    first = run("job")

    assert first.psf == "gaussian"
    assert run("job") == first
    assert run("another job") != first


def test_a_and_b_are_the_pair_the_blink_opens_with():
    # As frontend/src/blink.test.ts: D3 matches λ within half an element (±0.6 %).
    frames = [
        _frame(0, 0, 0, 1.65),
        _frame(1, 0, 1, 1.7),
        _frame(2, 1, 180, 1.7),
        _frame(3, 2, 360, 1.66),
        _frame(4, 2, 361, 1.8),
    ]
    assert default_pair(frames) == (0, 3)
    swapped = [_frame(0, 2, 360, 1.65), _frame(1, 0, 0, 1.65)]
    assert default_pair(swapped) == (1, 0)
    level = [_frame(i, i, 0, 1.65) for i in range(3)]
    assert default_pair(level) == (0, 2)  # equal baselines: the epochs furthest apart
    # Without a compatible pair: the first frame of the earliest and of the latest epoch.
    unknown = [_frame(i, epoch, 0) for i, epoch in enumerate([0, 0, 1, 1, 2, 2])]
    assert default_pair(unknown) == (0, 4)
    assert default_pair([_frame(i, 0, 0) for i in range(3)]) == (0, 2)
    assert default_pair([_frame(0, 0, 0)]) is None


def test_stars_land_on_free_usable_sky_apart_from_each_other():
    frame = _noise(4)
    frame.image[20:26, 30:36] = np.nan  # a masked patch
    existing = np.array([[15.0, 40.0], [44.0, 12.0]])

    allowed = _allowed(frame, existing)
    xs, ys = _positions(allowed, np.random.default_rng(0), 1000)

    assert 10 < xs.size < 60
    rows, cols = np.rint(ys).astype(int), np.rint(xs).astype(int)
    assert allowed[rows, cols].all()
    assert (xs > EDGE_PX - 1).all() and (xs < SHAPE[1] - EDGE_PX).all()
    for x, y in existing:
        assert (np.hypot(xs - x, ys - y) > CLEARANCE_PX - 1).all()
    # Nothing within the 5 × 5 fit of a star is masked.
    assert not allowed[18:28, 28:38].any()
    distances = np.hypot(xs[:, None] - xs, ys[:, None] - ys)[np.triu_indices(xs.size, 1)]
    assert distances.min() > SEPARATION_PX - 1.5


def test_fitting_only_near_the_stars_finds_the_same_sources():
    stars = [(10.3, 12.6, 40.0), (40.0, 30.2, 80.0), (25.7, 44.1, 20.0)]
    image = np.random.default_rng(5).normal(0.0, 1.0, SHAPE)
    draw = _gaussian_stars(GRID, SHAPE)
    xs, ys, peaks = (np.array(column) for column in zip(*stars, strict=True))
    frame = _noise(5)._replace(image=image + draw(xs, ys, peaks * 2 * math.pi * 0.68**2 * UJY))

    full, _ = detect(frame)
    near, _ = detect(frame, fit=_near(xs[:1], ys[:1], SHAPE))

    assert len(near) == 3
    assert [(d.peak, d.snr) for d in near] == [(d.peak, d.snr) for d in full]
    (fitted,) = [d for d in near if math.hypot(d.x - xs[0], d.y - ys[0]) < 1.5]
    assert [fitted] == [d for d in full if math.hypot(d.x - xs[0], d.y - ys[0]) < 1.5]
    # The others keep their peak pixel.
    assert all(d.x == int(d.x) and d.y == int(d.y) for d in near if d != fitted)


def test_the_share_found_rises_with_flux_and_its_crossings_are_interpolated_in_magnitudes():
    assert _monotonic(np.array([0.2, 0.1, 0.5, 1.0]), np.array([20, 20, 20, 20])).tolist() == [
        pytest.approx(0.15),
        pytest.approx(0.15),
        0.5,
        1.0,
    ]
    fluxes = np.array([1.0, 10.0, 100.0])
    assert _flux_at(np.array([0.0, 0.5, 1.0]), fluxes, 0.5) == pytest.approx(10.0)
    assert _flux_at(np.array([0.0, 0.5, 1.0]), fluxes, 0.75) == pytest.approx(math.sqrt(1000))
    assert _flux_at(np.array([0.6, 0.8, 1.0]), fluxes, 0.5) is None  # faintest step found already
    assert _flux_at(np.array([0.0, 0.2, 0.4]), fluxes, 0.5) is None  # never found that often


def _cutout_epsf(sigma_px: float, angle_deg: float, size: int = 81):
    """A cutout rotated against the grid with a Gaussian ePSF (oversampled 5 ×, pixel response
    included) of sigma_px detector pixels, as psf.cutout_epsf returns it."""
    d = (np.arange(33) - 16) / 5
    g = ndtr((d + 0.5) / sigma_px) - ndtr((d - 0.5) / sigma_px)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
    scale, angle = SPHEREX_PIXEL_SCALE_ARCSEC / 3600, math.radians(angle_deg)
    wcs.wcs.cd = scale * np.array(
        [[-math.cos(angle), math.sin(angle)], [math.sin(angle), math.cos(angle)]]
    )
    return EPSF(np.outer(g, g) / np.outer(g, g).sum(), (5, 5)), wcs, (size, size)


def test_epsf_stars_keep_their_flux_and_place_and_are_smoothed_like_the_data(monkeypatch):
    model, wcs, shape = _cutout_epsf(0.55, 30.0)  # FWHM 1.3 px, like the D6 zones
    monkeypatch.setattr(completeness, "cutout_epsf", lambda path, ra, dec: (model, wcs, shape))
    draw = _epsf_stars(Path("cutout.fits"), GRID, SHAPE)
    # 16 stars 10 px apart at sub-pixel positions that differ from star to star.
    xs, ys = (
        v.ravel() for v in np.meshgrid(12.0 + 10.13 * np.arange(4), 13.0 + 9.71 * np.arange(4))
    )

    stars = draw(xs, ys, np.full(xs.size, 1000.0))

    # Resampling keeps the total flux; one star scatters by about 1.5 %, as real ones do in align.
    assert stars.sum() * UJY == pytest.approx(16 * 1000.0, rel=0.01)
    rows, cols = np.indices(SHAPE)
    for x0, y0 in zip(xs, ys, strict=True):
        star = np.where(np.hypot(cols - x0, rows - y0) < 4, stars, 0.0)
        assert star.sum() * UJY == pytest.approx(1000.0, rel=0.06)
        x, y = (np.sum(star * axis) / star.sum() for axis in (cols, rows))
        assert (x, y) == (pytest.approx(x0, abs=0.05), pytest.approx(y0, abs=0.05))
        # The sampled ePSF (Gaussian and pixel: σ² + 1/12) plus the smoothing of bilinear
        # interpolation (1/6 px² per axis): the 1.3 px FWHM becomes about the 1.6 px of the grid.
        width = np.sqrt(np.sum(star * ((cols - x) ** 2 + (rows - y) ** 2)) / star.sum() / 2)
        assert width == pytest.approx(math.sqrt(0.55**2 + 1 / 12 + 1 / 6), rel=0.03)


def test_with_an_epsf_the_frame_is_measured_with_it(monkeypatch):
    model, wcs, shape = _cutout_epsf(0.55, 30.0)
    monkeypatch.setattr(completeness, "cutout_epsf", lambda path, ra, dec: (model, wcs, shape))
    frames = [_frame(0, 0, 61000.0)]

    measure_completeness("job", frames, [_noise(6)], [Path("cutout.fits")], GRID)

    limit = frames[0].completeness
    assert limit.psf == "epsf"
    # The resampled SPHEREx-like ePSF is about as wide as the grid PSF: about the same limit.
    assert limit.flux50_ujy == pytest.approx(_theory_flux(0.5), rel=0.15)


def _flux(ab: float | None) -> float | None:
    return None if ab is None else round(10 ** ((23.9 - ab) / 2.5), 1)


def _measured(ab50: float | None, ab90: float | None) -> Measured:
    limit = Completeness(
        psf="gaussian",
        injected=200,
        noise_ujy=12.5,
        flux50_ujy=_flux(ab50),
        flux90_ujy=_flux(ab90),
        ab50=ab50,
        ab90=ab90,
        false_per_frame=0,
        offset_arcsec=1.2,
    )
    return Measured(
        limit,
        [12.5 * level for level in LEVELS_SIGMA],
        [20] * 10,
        [0, 1, 6, 14, 17, 20, 20, 20, 20, 20],
    )


def test_the_check_says_how_many_stars_were_found_at_which_brightness():
    a, b = _frame(0, 0, 61000.0), _frame(8, 2, 61360.0)
    for frame in (a, b):
        frame.detector = 6

    (one,) = completeness_checks([(a, _measured(18.71, 18.24))])
    (same,) = completeness_checks([(a, _measured(18.71, 18.24)), (b, _measured(18.69, 18.2))])
    (two,) = completeness_checks([(a, _measured(18.71, 18.24)), (b, _measured(18.62, None))])

    assert (one.code, one.severity) == ("DETECTION_LIMIT", "info")
    assert one.message == (
        "Detection limit measured by injecting 200 artificial stars: 50 % found at 18.7 AB"
        ", 90 % at 18.2 AB"
    )
    assert same.message.startswith("Detection limit measured by injecting 400 artificial stars")
    assert "50 % found at 18.7 AB, 90 % at 18.2 AB" in same.message
    assert two.message.endswith(
        "50 % found at 18.7 AB in frame 1 and at 18.6 AB in frame 9, 90 % at 18.2 AB in "
        "frame 1 and not reached in frame 9"
    )
    assert "Frame 9: 50 % at 129.4 µJy (18.62 AB), 90 % not reached within the steps" in two.detail
    assert "found 0, 1, 6, 14, 17, 20, 20, 20, 20, 20 of 20, 20" in one.detail
    assert completeness_checks([]) == []


def _observation(mjd: float) -> Observation:
    return Observation(
        obs_id=f"obs-{mjd:.0f}",
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=mjd,
        date=f"mjd-{mjd:.0f}",
        access_url=f"https://irsa.invalid/{mjd:.0f}.fits",
    )


def test_the_final_a_and_b_carry_a_measured_limit_the_preview_none(monkeypatch, settings, tmp_path):
    observations = [_observation(100), _observation(290), _observation(470)]
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(
        tasks, "search_observations", lambda ra, dec, settings, collections: (observations, [])
    )
    monkeypatch.setattr(
        tasks,
        "fetch_cutout",
        lambda client, url, directory: tmp_path / url.split("?")[0].rsplit("/", 1)[1],
    )
    # Unit noise in every exposure, no ePSF and no catalogue source.
    monkeypatch.setattr(
        tasks,
        "read_image",
        lambda path: (_noise(int(path.stem)).image, np.ones(SHAPE), GRID, np.zeros(SHAPE, bool)),
    )
    monkeypatch.setattr(completeness, "cutout_epsf", lambda path, ra, dec: None)
    monkeypatch.setattr(sources, "query_gaia", lambda *_: [])
    monkeypatch.setattr(sources, "query_allwise", lambda *_: [])
    # The first two epochs match in λ: they are the pair the blink opens with, not the last.
    wavelengths = {"100": 4.600, "290": 4.601, "470": 4.8}
    monkeypatch.setattr(
        tasks, "wavelength_at", lambda path, ra, dec: (wavelengths[path.stem], 0.035)
    )
    measured = []
    original = tasks.measure_completeness

    def measure_and_count(key, frames, *rest):
        measured.append(len(frames))
        return original(key, frames, *rest)

    monkeypatch.setattr(tasks, "measure_completeness", measure_and_count)

    final = FrameManifest.model_validate(build_frames("job", RA, DEC, SIZE_DEG, 6, 12))

    preview = FrameManifest.model_validate_json(
        (settings.cache_dir / "frames" / "job" / "preview.json").read_text()
    )
    assert preview.preview and measured == [3]  # previews were published but never measured
    assert all(frame.completeness is None for frame in preview.frames)
    assert "DETECTION_LIMIT" not in [check.code for check in preview.checks]
    assert [frame.completeness is not None for frame in final.frames] == [True, True, False]
    a, b = (final.frames[i].completeness for i in (0, 1))
    assert (a.psf, a.injected) == ("gaussian", len(LEVELS_SIGMA) * STARS_PER_LEVEL)
    assert a.flux50_ujy == pytest.approx(_theory_flux(0.5), rel=0.15)
    assert b.ab50 == pytest.approx(a.ab50, abs=0.15)
    (check,) = [c for c in final.checks if c.code == "DETECTION_LIMIT"]
    assert check.severity == "info"
    assert check.message.startswith("Detection limit measured by injecting 400 artificial stars")
    assert "(D6)" not in check.message


@pytest.mark.parametrize(
    "case",
    json.loads((Path(__file__).parent / "fixtures/blink_pair.json").read_text()),
    ids=lambda case: case["name"],
)
def test_default_pair_shared_with_frontend(case):
    frames = [
        _frame(i, f["epoch"], f["mjd"], f["wavelength_um"]) for i, f in enumerate(case["frames"])
    ]
    expected = tuple(case["expected"]) if case["expected"] is not None else None
    assert default_pair(frames) == expected


def test_detection_limit_below_faintest_step_is_not_reported_as_not_reached():
    result = _measured(None, None)._replace(found=[20] * 10)
    (check,) = completeness_checks([(_frame(0, 0, 61000), result)])
    assert "fainter than" in check.message
    assert "not reached" not in check.message


def test_uncapped_detection_keeps_faint_sources_in_crowded_fields():
    grid, shape = target_grid(RA, DEC, 0.4)
    rng = np.random.default_rng(123)
    ys, xs = np.mgrid[10 : shape[0] - 10 : 10, 10 : shape[1] - 10 : 10]
    xs, ys = xs.ravel().astype(float), ys.ravel().astype(float)
    assert len(xs) > sources.MAX_SOURCES
    draw = _gaussian_stars(grid, shape)
    fluxes = np.linspace(100, 300, len(xs)) * UJY
    image = rng.normal(0, 1, shape) + draw(xs, ys, fluxes)
    frame = Aligned(image, np.ones(shape), np.ones(shape, bool))
    no_fits = np.zeros(shape, bool)
    capped, was_capped = detect(frame, fit=no_fits)
    all_sources, was_capped_all = detect(frame, fit=no_fits, cap=False)
    assert was_capped and len(capped) == sources.MAX_SOURCES
    assert not was_capped_all and len(all_sources) > sources.MAX_SOURCES
    assert min(d.peak for d in all_sources) < min(d.peak for d in capped)
