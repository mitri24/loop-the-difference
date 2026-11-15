import httpx
import numpy as np
import pytest
from PIL import Image

from app import completeness, sources, tasks
from app.catalogs import gaia_cache_path, position_at
from app.frames import Aligned, aligned_path, load_aligned, target_grid
from app.models import Observation, ProperMotion
from app.photometry import SKIP_EDGE, SKIP_NAN
from app.tasks import build_frames, build_spectrum, epoch_checks, stack_images, wavelength_checks

RA, DEC, SIZE_DEG = 133.795, -7.245, 0.1


@pytest.mark.parametrize(
    ("usable", "epochs", "code", "severity"),
    [
        (0, 0, "NO_OBSERVATIONS", "error"),
        (1, 1, "SINGLE_EPOCH", "blocker"),
        (3, 1, "NO_TIME_BASELINE", "blocker"),
    ],
)
def test_too_little_data_blocks_the_comparison(usable, epochs, code, severity):
    (check,) = epoch_checks(usable, epochs)

    assert (check.code, check.severity) == (code, severity)
    assert check.affects == ["difference"]
    assert check.detail


def test_two_epochs_pass_without_a_check():
    assert epoch_checks(4, 2) == []


def _aligned(image: np.ndarray, variance: float = 1.0) -> Aligned:
    return Aligned(image, np.where(np.isnan(image), np.nan, variance), ~np.isnan(image))


def test_stack_removes_a_cosmic_ray_and_keeps_the_footprint():
    clean = np.zeros((10, 10))
    clean[:, 0] = np.nan
    hit = clean.copy()
    hit[5, 5] = 1000.0

    stacked = stack_images([_aligned(clean), _aligned(hit), _aligned(clean)])

    assert stacked.image[5, 5] == 0.0
    assert np.isnan(stacked.image[:, 0]).all()
    assert np.isnan(stacked.variance[:, 0]).all()
    assert not stacked.covered[:, 0].any()
    assert stack_images([_aligned(hit)]).image is hit


def test_stack_weights_each_exposure_by_its_sky_variance():
    noisy, quiet, masked = np.full((4, 4), 4.0), np.full((4, 4), 1.0), np.full((4, 4), 2.0)
    masked[0, 0] = np.nan

    stacked = stack_images([_aligned(noisy, 4.0), _aligned(quiet, 1.0), _aligned(masked, 2.0)])

    # Weights 1/4, 1 and 1/2 (none of the three is clipped: all lie within 3σ of the median 2).
    assert stacked.image[1, 1] == pytest.approx((4 / 4 + 1 + 2 / 2) / (1 / 4 + 1 + 1 / 2))
    assert stacked.variance[1, 1] == pytest.approx(1 / (1 / 4 + 1 + 1 / 2))
    assert stacked.image[0, 0] == pytest.approx((4 / 4 + 1) / (1 / 4 + 1))
    assert stacked.variance[0, 0] == pytest.approx(1 / (1 / 4 + 1))


def test_a_stars_own_photon_noise_does_not_pull_its_stack_down():
    # Same sky, so equal weights; the star's VARIANCE grows with its brightness in each exposure.
    exposures = []
    for level in (900.0, 1000.0, 1100.0):
        image = np.zeros((5, 5))
        image[2, 2] = level
        exposures.append(Aligned(image, 1.0 + image / 10, np.ones((5, 5), dtype=bool)))

    stacked = stack_images(exposures)

    assert stacked.image[2, 2] == pytest.approx(1000.0)  # 1/VARIANCE per pixel gave 993.4
    assert stacked.variance[2, 2] == pytest.approx((91 + 101 + 111) / 9)
    assert stacked.variance[0, 0] == pytest.approx(1 / 3)


def test_a_bright_star_that_differs_between_exposures_is_not_clipped():
    # Each exposure sees the star at its own wavelength: up to 25 % apart, far beyond its noise.
    star = [_aligned(np.full((3, 3), level)) for level in (900.0, 1000.0, 1050.0, 1250.0)]

    assert stack_images(star).image[1, 1] == pytest.approx(1050.0)


def _observation(mjd: float) -> Observation:
    return Observation(
        obs_id=f"obs-{mjd}",
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=mjd,
        date=f"mjd-{mjd}",
        access_url=f"https://irsa.invalid/{mjd:.0f}.fits",
        cloud_url=f"https://s3.invalid/{mjd:.0f}.fits",
    )


def _png(settings, frame: dict) -> np.ndarray:
    name = frame["url"].rsplit("/", 1)[1]
    return np.asarray(Image.open(settings.cache_dir / "frames" / "job" / name))


def _offline_archive(monkeypatch, settings, tmp_path, observations, flagged_target=False):
    """Three synthetic epochs on the target grid itself; one exposure carries a cosmic ray."""
    target, shape = target_grid(RA, DEC, SIZE_DEG)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(
        tasks, "search_observations", lambda ra, dec, settings, collections: (observations, [])
    )
    monkeypatch.setattr(
        tasks,
        "fetch_cutout",
        lambda client, url, directory: tmp_path / url.split("?")[0].rsplit("/", 1)[1],
    )

    def read_image(path):
        data = np.full(shape, 5.0)
        if path.name == "100.fits":
            data[shape[0] // 2, shape[1] // 2] = 5000.0
        unusable = np.zeros(shape, dtype=bool)
        unusable[:3] = True
        if flagged_target and path.name == "100.fits":
            unusable[shape[0] // 2 + 1, shape[1] // 2] = True
        data[unusable] = np.nan
        return data, np.where(unusable, np.nan, 1.0), target, unusable

    monkeypatch.setattr(tasks, "read_image", read_image)
    # The synthetic cutouts carry no ePSF table.
    monkeypatch.setattr(tasks, "aperture_correction", lambda path, ra, dec: None)
    monkeypatch.setattr(completeness, "cutout_epsf", lambda path, ra, dec: None)
    # Each visit sees the target through another part of the filter: λ grows with the MJD.
    monkeypatch.setattr(
        tasks, "wavelength_at", lambda path, ra, dec: (4.5 + int(path.stem) / 1000, 0.035)
    )


def test_stacked_job_yields_one_frame_per_epoch(monkeypatch, settings, tmp_path):
    observations = [_observation(start + i) for start in (100, 290, 470) for i in range(3)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)

    manifest = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=True)

    assert manifest["stacked"] is True
    assert manifest["epochs"] == 3
    frames = manifest["frames"]
    assert [(f["epoch"], f["n_combined"]) for f in frames] == [(0, 3), (1, 3), (2, 3)]
    assert (frames[0]["date"], frames[0]["date_end"], frames[0]["mjd"]) == (
        "mjd-100",
        "mjd-102",
        101,
    )
    assert all(
        (settings.cache_dir / "frames" / "job" / f"frame_0{i}.png").exists() for i in range(3)
    )
    # A stack's provenance is its first exposure: obs_id, cutout and full file belong together.
    assert (frames[1]["obs_id"], frames[1]["cloud_url"]) == (
        "obs-290",
        "https://s3.invalid/290.fits",
    )
    assert frames[1]["source_url"].startswith("https://irsa.invalid/290.fits?")
    # The cosmic ray in exposure 100 is gone from the first stack: the frames are all alike.
    pixels = [_png(settings, f) for f in frames]
    assert (pixels[0] == pixels[1]).all()
    assert [(d["a"], d["b"], d["url"]) for d in manifest["differences"]] == [
        (0, 1, "/api/frames/job/diff_00_01.png"),
        (0, 2, "/api/frames/job/diff_00_02.png"),
        (1, 2, "/api/frames/job/diff_01_02.png"),
    ]
    first = manifest["differences"][0]
    assert first["obs_ids_a"] == ["obs-100", "obs-101", "obs-102"]
    assert first["obs_ids_b"] == ["obs-290", "obs-291", "obs-292"]
    assert (settings.cache_dir / "frames" / "job" / "diff_01_02.png").exists()
    # Every frame keeps its unfilled stack and its cutouts with their weights, for its changes.
    stacked, cutouts, weights = load_aligned(aligned_path(settings.cache_dir / "frames" / "job", 0))
    assert cutouts == ["100.fits", "101.fits", "102.fits"]
    assert weights == pytest.approx([1.0, 1.0, 1.0])
    middle = stacked.image.shape[0] // 2
    assert np.isnan(stacked.image[:3]).all() and stacked.image[middle, middle] == pytest.approx(0.0)
    # Median wavelength of the three stacked exposures; epochs 190 days apart saw another λ.
    assert (frames[0]["wavelength_um"], frames[0]["bandwidth_um"]) == (4.601, 0.035)
    assert first["comparable"] is False
    assert first["delta_lambda_pct"] == pytest.approx(4.05, abs=0.01)
    assert "WAVELENGTH_MISMATCH" in [c["code"] for c in manifest["checks"]]
    assert "WAVELENGTH_UNKNOWN" not in [c["code"] for c in manifest["checks"]]


def test_one_epoch_gives_no_difference_and_blocks_it(monkeypatch, settings, tmp_path):
    _offline_archive(monkeypatch, settings, tmp_path, [_observation(100 + i) for i in range(3)])

    manifest = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=True)

    assert manifest["differences"] == []
    assert [(c["code"], c["severity"]) for c in manifest["checks"]] == [
        ("NO_TIME_BASELINE", "blocker")
    ]


def test_exposure_job_numbers_the_epoch_of_every_frame(monkeypatch, settings, tmp_path):
    observations = [_observation(start + i) for start in (100, 290) for i in range(2)]
    _offline_archive(monkeypatch, settings, tmp_path, observations, flagged_target=True)

    manifest = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=False)

    assert manifest["stacked"] is False
    frames = manifest["frames"]
    assert [(f["epoch"], f["n_combined"], f["date_end"]) for f in frames] == [
        (0, 1, None),
        (0, 1, None),
        (1, 1, None),
        (1, 1, None),
    ]
    assert [f["obs_id"] for f in frames] == [o.obs_id for o in observations]
    # The three flagged rows, and pixels of the next row that bilinear resampling touches them with.
    rows = target_grid(RA, DEC, SIZE_DEG)[1][0]
    assert all(3 / rows <= f["masked_fraction"] <= 4 / rows for f in frames)
    flagged = [c for c in manifest["checks"] if c["code"] == "FLAGGED_PIXELS"]
    assert [(c["severity"], c["affects"]) for c in flagged] == [("warning", ["obs:obs-100"])]
    # Without stacking the cosmic ray in exposure 100 stays visible.
    pixels = [_png(settings, f) for f in frames]
    assert (pixels[0] != pixels[1]).any()
    assert manifest["differences"] == []


def test_frames_carry_the_archive_metadata_and_a_stack_combines_it(monkeypatch, settings, tmp_path):
    shared = {
        "exposure_s": 113.5826,
        "spatial_resolution_arcsec": 3.075,
        "resolving_power": 127.8,
        "calib_level": 2,
        "instrument_name": "SPHEREx",
        "facility_name": "SPHEREx",
        "pixel_scale_arcsec": 6.15,
    }
    observations = [
        _observation(mjd).model_copy(
            update={
                **shared,
                "start_mjd": mjd - 0.0007,
                "end_mjd": mjd + 0.0007,
                "publisher_did": f"ivo://irsa.ipac/spherex_dr1?obs-{mjd}/D6",
                "release_date": f"2026-10-0{i + 1}T12:00:00Z",
            }
        )
        for i, mjd in enumerate([100, 101, 102, 290, 291, 292])
    ]
    # Exposure 291 lacks its exposure time and was calibrated to another level.
    observations[4] = observations[4].model_copy(update={"exposure_s": None, "calib_level": 3})
    _offline_archive(monkeypatch, settings, tmp_path, observations)

    single = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=False)["frames"]
    stacks = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=True)["frames"]

    assert (single[0]["exposure_s"], single[0]["start_mjd"], single[0]["end_mjd"]) == (
        113.5826,
        100 - 0.0007,
        100 + 0.0007,
    )
    assert [(f["exposure_s"], f["calib_level"]) for f in single[3:]] == [
        (113.5826, 2),
        (None, 3),
        (113.5826, 2),
    ]
    first, second = stacks
    assert first["exposure_s"] == pytest.approx(3 * 113.5826)
    assert (first["start_mjd"], first["end_mjd"]) == (100 - 0.0007, 102 + 0.0007)
    # Named by its first exposure, like obs_id; public once its last exposure is.
    assert first["publisher_did"] == "ivo://irsa.ipac/spherex_dr1?obs-100/D6"
    assert first["release_date"] == "2026-10-03T12:00:00Z"
    assert {key: first[key] for key in shared if key != "exposure_s"} == {
        key: value for key, value in shared.items() if key != "exposure_s"
    }
    # A stack claims no value its exposures disagree on or one of them lacks.
    assert (second["exposure_s"], second["calib_level"], second["resolving_power"]) == (
        None,
        None,
        127.8,
    )


def test_wavelength_spread_beyond_one_resolution_element_blocks_the_difference():
    (check,) = wavelength_checks([4.50, None, 4.60], detector=6)

    assert (check.code, check.severity) == ("WAVELENGTH_MISMATCH", "blocker")
    assert check.affects == ["difference"]
    assert "4.500" in check.detail and "4.600" in check.detail


def test_wavelength_spread_within_one_resolution_element_warns():
    (check,) = wavelength_checks([4.50, 4.53], detector=6)  # 0.85 λ/R at R = 128

    assert (check.code, check.severity) == ("WAVELENGTH_CLOSE", "warning")
    assert check.affects == ["difference"]
    assert "0.85 resolution elements" in check.detail


def test_matching_wavelengths_pass_without_a_check():
    assert wavelength_checks([4.50, 4.51, None], detector=6) == []
    assert wavelength_checks([4.50], detector=6) == []


def test_spectrum_has_one_point_per_visit_of_every_detector(monkeypatch, settings, tmp_path):
    observations = [_observation(100), _observation(101), _observation(102), _observation(290)]
    observations[1] = observations[1].model_copy(update={"detector": 2})
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    fluxes = {"100": (50.0, 2.0, False), "101": SKIP_NAN, "102": (1.0, 1.0, False)}
    fluxes["290"] = (40.0, 3.0, True)
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: fluxes[path.stem])
    wavelength = tasks.wavelength_at
    monkeypatch.setattr(
        tasks,
        "wavelength_at",
        lambda path, ra, dec: (None, None) if path.stem == "102" else wavelength(path, ra, dec),
    )
    monkeypatch.setattr(tasks, "find_proper_motion", lambda ra, dec, strict, cache_dir: None)

    spectrum = build_spectrum(RA, DEC)

    points = spectrum["points"]
    assert [(p["obs_id"], p["epoch"], p["wavelength_um"]) for p in points] == [
        ("obs-100", 0, 4.6),
        ("obs-290", 1, 4.79),
    ]
    assert (points[0]["flux_ujy"], points[0]["flux_err_ujy"]) == (50.0, 2.0)
    assert [p["flagged"] for p in points] == [False, True]
    assert "size=0.0426" in points[0]["source_url"]
    assert [c["code"] for c in spectrum["checks"]] == [
        "QUICK_LOOK_SPECTRUM",
        "SPECTRUM_POINTS_FLAGGED",
        "SPECTRUM_POINTS_SKIPPED",
    ]
    assert spectrum["checks"][-1]["detail"] == (
        f"2 visits skipped: 1 {SKIP_NAN}, 1 no WCS-WAVE table"
    )


@pytest.mark.parametrize(
    ("factors", "fluxes"),
    [
        ({"100": 1.25, "290": 1.5}, [(62.5, 2.5), (60.0, 4.5)]),
        ({"100": 1.25}, [(50.0, 2.0), (40.0, 3.0)]),
    ],
)
def test_spectrum_is_corrected_to_total_flux_only_when_every_visit_has_an_epsf(
    monkeypatch, settings, tmp_path, factors, fluxes
):
    _offline_archive(monkeypatch, settings, tmp_path, [_observation(100), _observation(290)])
    measured = {"100": (50.0, 2.0, False), "290": (40.0, 3.0, False)}
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: measured[path.stem])
    monkeypatch.setattr(tasks, "aperture_correction", lambda path, ra, dec: factors.get(path.stem))
    monkeypatch.setattr(tasks, "find_proper_motion", lambda ra, dec, strict, cache_dir: None)

    spectrum = build_spectrum(RA, DEC)

    assert [(p["flux_ujy"], p["flux_err_ujy"]) for p in spectrum["points"]] == fluxes
    (method,) = [c for c in spectrum["checks"] if c["code"] == "QUICK_LOOK_SPECTRUM"]
    assert ("corrected to total flux" in method["detail"]) is (len(factors) == 2)


def test_only_measured_points_are_corrected(monkeypatch, settings, tmp_path):
    _offline_archive(monkeypatch, settings, tmp_path, [_observation(100), _observation(290)])
    measured = {"100": (50.0, 2.0, False), "290": SKIP_EDGE}
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: measured[path.stem])

    def correction(path, ra, dec):
        assert path.stem == "100", "a target off the cutout has no aperture to correct"
        return 1.25

    monkeypatch.setattr(tasks, "aperture_correction", correction)
    monkeypatch.setattr(tasks, "find_proper_motion", lambda ra, dec, strict, cache_dir: None)

    spectrum = build_spectrum(RA, DEC)

    assert [(p["flux_ujy"], p["flux_err_ujy"]) for p in spectrum["points"]] == [(62.5, 2.5)]
    assert spectrum["checks"][0]["code"] == "QUICK_LOOK_SPECTRUM"
    assert "(×1.25–1.25, total within ±3.2 px)" in spectrum["checks"][0]["detail"]


def test_spectrum_follows_a_star_with_proper_motion_to_each_visit(monkeypatch, settings, tmp_path):
    observations = [_observation(100), _observation(290)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    star = ProperMotion(
        source_id="42",
        ra=RA,
        dec=DEC,
        ref_epoch=2016.0,
        pmra_mas_yr=0.0,
        pmdec_mas_yr=36000.0,
        parallax_mas=None,
    )
    monkeypatch.setattr(tasks, "find_proper_motion", lambda ra, dec, strict, cache_dir: star)
    measured = []

    def photometry(path, ra, dec):
        measured.append(round(dec - DEC, 3))
        return 1.0, 0.1, False

    monkeypatch.setattr(tasks, "forced_photometry", photometry)

    spectrum = build_spectrum(RA, DEC)

    assert measured == [round(position_at(star, o.mjd)[1] - DEC, 3) for o in observations]
    assert f"{position_at(star, 100)[1]:.6f}" in spectrum["points"][0]["source_url"]
    assert "SPECTRUM_PROPER_MOTION" in [c["code"] for c in spectrum["checks"]]


def test_spectrum_without_gaia_says_so_and_stays_incomplete(monkeypatch, settings, tmp_path):
    _offline_archive(monkeypatch, settings, tmp_path, [_observation(100)])
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: (1.0, 0.1, False))

    spectrum = build_spectrum(RA, DEC)  # conftest makes every Gaia request fail

    assert "SPECTRUM_GAIA_UNAVAILABLE" in [c["code"] for c in spectrum["checks"]]
    assert spectrum["complete"] is False
    assert len(spectrum["points"]) == 1


def test_a_warmed_spectrum_keeps_the_star_motion_while_gaia_is_down(
    monkeypatch, settings, tmp_path
):
    _offline_archive(monkeypatch, settings, tmp_path, [_observation(100)])
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: (1.0, 0.1, False))
    cached = gaia_cache_path(settings.cache_dir, RA, DEC)
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(
        "source_id,ra,dec,pmra,pmdec,parallax,parallax_over_error,ref_epoch\n"
        f"42,{RA},{DEC},0.0,0.0,100.0,50.0,2000.0\n"
    )

    spectrum = build_spectrum(RA, DEC)  # conftest makes every Gaia request fail

    codes = [c["code"] for c in spectrum["checks"]]
    assert "SPECTRUM_PROPER_MOTION" in codes
    assert "SPECTRUM_GAIA_UNAVAILABLE" not in codes


def test_every_frame_lists_its_sources_with_png_pixel_positions(monkeypatch, settings, tmp_path):
    observations = [_observation(start + i) for start in (100, 290) for i in range(2)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    target, shape = target_grid(RA, DEC, SIZE_DEG)
    y, x = np.mgrid[: shape[0], : shape[1]]
    star = 300.0 * np.exp(-((x - 8.0) ** 2 + (y - 5.0) ** 2) / (2 * 0.68**2))

    def read_image(path):
        noise = np.random.default_rng(int(path.stem)).normal(0.0, 1.0, shape)
        return noise + star, np.ones(shape), target, np.zeros(shape, dtype=bool)

    monkeypatch.setattr(tasks, "read_image", read_image)
    monkeypatch.setattr(sources, "query_gaia", lambda *_: [])
    monkeypatch.setattr(sources, "query_allwise", lambda *_: [])

    manifest = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=False)

    assert manifest["pipeline_version"] == tasks.PIPELINE_VERSION
    for frame in manifest["frames"]:
        (source,) = frame["sources"]
        assert source["match"] == "none"
        # x/y address the PNG: the star sits at array row 5, i.e. near the bottom of the image.
        assert (round(source["x"]), round(source["y"])) == (8, shape[0] - 1 - 5)
        assert _png(settings, frame)[round(source["y"]), round(source["x"])] > 200
    (check,) = [c for c in manifest["checks"] if c["code"] == "SOURCES"]
    assert check["severity"] == "info"
    assert "4 detections in 4 frames" in check["detail"]


def test_frames_carry_their_release_and_a_mix_is_said(monkeypatch, settings, tmp_path):
    dr1 = [_observation(100 + i).model_copy(update={"collection": "spherex_dr1"}) for i in range(3)]
    qr3 = [_observation(290 + i).model_copy(update={"collection": "spherex_qr3"}) for i in range(3)]
    _offline_archive(monkeypatch, settings, tmp_path, dr1 + qr3)
    monkeypatch.setattr(
        tasks,
        "search_observations",
        lambda ra, dec, settings, collections: (dr1 + qr3, ["spherex_dr1_deep"]),
    )

    manifest = build_frames(
        "job", RA, DEC, SIZE_DEG, 6, 12, collections=["spherex_dr1", "spherex_dr1_deep"]
    )

    assert [f["release"] for f in manifest["frames"]] == ["DR1"] * 3 + ["QR3"] * 3
    assert manifest["release"] == "DR1 + QR3"
    assert manifest["collection"] == "spherex_dr1,spherex_dr1_deep"
    checks = {c["code"]: c for c in manifest["checks"]}
    mixed = checks["MIXED_RELEASES"]
    assert mixed["message"] == "Mixed releases: DR1 + QR3 (different calibration versions)"
    assert mixed["severity"] == "info"
    assert checks["RELEASE_UNAVAILABLE"]["severity"] == "warning"
    assert "spherex_dr1_deep" in checks["RELEASE_UNAVAILABLE"]["detail"]
    # The release that did not answer is asked again on the next request.
    assert manifest["complete"] is False


def test_a_deep_field_of_the_same_release_is_no_mix(monkeypatch, settings, tmp_path):
    dr1 = [_observation(100 + i).model_copy(update={"collection": "spherex_dr1"}) for i in range(3)]
    deep = _observation(103).model_copy(update={"collection": "spherex_dr1_deep"})
    _offline_archive(monkeypatch, settings, tmp_path, [*dr1, deep])

    manifest = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, collections=["spherex_dr1"])

    assert manifest["release"] == "DR1 + DR1 deep"
    assert manifest["complete"] is True
    codes = [c["code"] for c in manifest["checks"]]
    assert "MIXED_RELEASES" not in codes
    assert "RELEASE_UNAVAILABLE" not in codes


def test_preview_is_published_before_slow_cutout(monkeypatch, settings, tmp_path):
    from threading import Event

    from app.models import FrameManifest

    observations = [_observation(100), _observation(290), _observation(470)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    published = Event()
    original_render = tasks._render_frames
    previews = []

    def render(*args, **kwargs):
        result = original_render(*args, **kwargs)
        if kwargs.get("preview"):
            path = settings.cache_dir / "frames" / "job" / "preview.json"
            preview = FrameManifest.model_validate_json(path.read_text())
            assert preview.preview and not preview.complete and not preview.stacked
            assert not preview.differences
            assert not (path.parent / "manifest.json").exists()
            assert all("preview_" in f.url for f in preview.frames)
            assert any(c.code == "PREVIEW" for c in preview.checks)
            previews.append(result)
            published.set()
        return result

    def fetch(client, url, directory):
        if "/100.fits" in url:
            assert published.wait(3), "a slow first request blocked ready observations"
        return tmp_path / url.split("?")[0].rsplit("/", 1)[1]

    monkeypatch.setattr(tasks, "_render_frames", render)
    monkeypatch.setattr(tasks, "fetch_cutout", fetch)
    final = build_frames("job", RA, DEC, SIZE_DEG, 6, 12, stack=True)
    assert previews
    assert final["complete"] and not final["preview"] and final["stacked"]
    assert [f["obs_id"] for f in final["frames"]] == [o.obs_id for o in observations]
    assert all("preview_" not in f["url"] for f in final["frames"])
    assert "PREVIEW" not in [c["code"] for c in final["checks"]]


def test_missing_cutout_says_why_the_archive_did_not_deliver(monkeypatch, settings):
    def fetch(client, url, directory):
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(tasks, "fetch_cutout", fetch)
    observation = _observation(61000)

    downloaded, checks = tasks.download_cutouts([observation], [observation.access_url], settings)

    assert downloaded == []
    assert [c.code for c in checks] == ["CUTOUT_MISSING"]
    assert f"no answer within {settings.http_timeout_s:g} s, after 5 attempts" in checks[0].detail
    assert checks[0].detail.startswith(
        f"{observation.obs_id}: archive did not deliver the cutout ("
    )


def test_progressive_previews_decode_and_align_each_download_only_once(
    monkeypatch, settings, tmp_path
):
    observations = [_observation(mjd) for mjd in (100, 290, 470, 650)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    read = tasks.read_image
    align = tasks.align
    decoded, aligned = [], []

    def counted_read(path):
        decoded.append(path)
        return read(path)

    def counted_align(*args):
        aligned.append(1)
        return align(*args)

    monkeypatch.setattr(tasks, "read_image", counted_read)
    monkeypatch.setattr(tasks, "align", counted_align)
    result = tasks.build_frames("job", RA, DEC, SIZE_DEG, 6, 12)
    assert len(result["frames"]) == 4
    assert len(decoded) == len(set(decoded)) == len(observations)
    assert len(aligned) == len(observations)
    assert (settings.cache_dir / "frames/job/preview.json").is_file()
