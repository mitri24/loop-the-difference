import numpy as np
import pytest
from PIL import Image

from app import tasks
from app.frames import target_grid
from app.models import Observation
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


def test_median_stack_removes_a_cosmic_ray_and_keeps_the_footprint():
    clean = np.zeros((10, 10))
    clean[:, 0] = np.nan
    hit = clean.copy()
    hit[5, 5] = 1000.0

    stacked = stack_images([clean, hit, clean])

    assert stacked[5, 5] == 0.0
    assert np.isnan(stacked[:, 0]).all()
    assert stack_images([hit]) is hit


def _observation(mjd: float) -> Observation:
    return Observation(
        obs_id=f"obs-{mjd}",
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=mjd,
        date=f"mjd-{mjd}",
        access_url=f"https://irsa.invalid/{mjd:.0f}.fits",
    )


def _png(settings, frame: dict) -> np.ndarray:
    name = frame["url"].rsplit("/", 1)[1]
    return np.asarray(Image.open(settings.cache_dir / "frames" / "job" / name))


def _offline_archive(monkeypatch, settings, tmp_path, observations, flagged_target=False):
    """Three synthetic epochs on the target grid itself; one exposure carries a cosmic ray."""
    target, shape = target_grid(RA, DEC, SIZE_DEG)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "search_observations", lambda ra, dec, settings: observations)
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
            unusable[shape[0] // 2, shape[1] // 2] = True
        return data, target, unusable

    monkeypatch.setattr(tasks, "read_image", read_image)
    # Each visit sees the target through another part of the filter: λ grows with the MJD.
    monkeypatch.setattr(
        tasks, "wavelength_at", lambda path, ra, dec: (4.5 + int(path.stem) / 1000, 0.035)
    )


def test_stacked_job_yields_one_median_frame_per_epoch(monkeypatch, settings, tmp_path):
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
    rows = target_grid(RA, DEC, SIZE_DEG)[1][0]
    assert all(f["masked_fraction"] == round(3 / rows, 3) for f in frames)
    flagged = [c for c in manifest["checks"] if c["code"] == "FLAGGED_PIXELS"]
    assert [(c["severity"], c["affects"]) for c in flagged] == [("warning", ["obs:obs-100"])]
    # Without stacking the cosmic ray in exposure 100 stays visible.
    pixels = [_png(settings, f) for f in frames]
    assert (pixels[0] != pixels[1]).any()
    assert manifest["differences"] == []


def test_wavelength_spread_beyond_one_resolution_element_blocks_the_difference():
    (check,) = wavelength_checks([4.50, None, 4.60], detector=6)

    assert (check.code, check.severity) == ("WAVELENGTH_MISMATCH", "blocker")
    assert check.affects == ["difference"]
    assert "4.500" in check.detail and "4.600" in check.detail


def test_matching_wavelengths_pass_without_a_check():
    assert wavelength_checks([4.50, 4.51, None], detector=6) == []
    assert wavelength_checks([4.50], detector=6) == []


def test_spectrum_has_one_point_per_visit_of_every_detector(monkeypatch, settings, tmp_path):
    observations = [_observation(100), _observation(101), _observation(290)]
    observations[1] = observations[1].model_copy(update={"detector": 2})
    _offline_archive(monkeypatch, settings, tmp_path, observations)
    fluxes = {"100": (50.0, 2.0), "101": (None, None), "290": (40.0, 3.0)}
    monkeypatch.setattr(tasks, "forced_photometry", lambda path, ra, dec: fluxes[path.stem])

    spectrum = build_spectrum(RA, DEC)

    points = spectrum["points"]
    assert [(p["obs_id"], p["epoch"], p["wavelength_um"]) for p in points] == [
        ("obs-100", 0, 4.6),
        ("obs-290", 1, 4.79),
    ]
    assert (points[0]["flux_ujy"], points[0]["flux_err_ujy"]) == (50.0, 2.0)
    assert "size=0.0426" in points[0]["source_url"]
    assert [c["code"] for c in spectrum["checks"]] == [
        "QUICK_LOOK_SPECTRUM",
        "SPECTRUM_POINTS_SKIPPED",
    ]
