import numpy as np
import pytest
from PIL import Image

from app import tasks
from app.frames import target_grid
from app.models import Observation
from app.tasks import build_frames, epoch_checks, stack_images

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


def _offline_archive(monkeypatch, settings, tmp_path, observations):
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
        return data, target

    monkeypatch.setattr(tasks, "read_image", read_image)


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


def test_exposure_job_numbers_the_epoch_of_every_frame(monkeypatch, settings, tmp_path):
    observations = [_observation(start + i) for start in (100, 290) for i in range(2)]
    _offline_archive(monkeypatch, settings, tmp_path, observations)

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
    # Without stacking the cosmic ray in exposure 100 stays visible.
    pixels = [_png(settings, f) for f in frames]
    assert (pixels[0] != pixels[1]).any()
