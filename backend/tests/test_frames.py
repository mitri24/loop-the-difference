from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from app import frames
from app.frames import (
    Aligned,
    align,
    comparable_wavelengths,
    for_display,
    read_image,
    render_diff,
    render_png,
    target_grid,
    target_is_flagged,
    wavelength_at,
)

RA, DEC = 133.795, -7.245
# Real D6 cutout header plus its WCS-WAVE table, pixel data removed; this is its centre pixel.
CUTOUT_HEADER = Path(__file__).parent / "fixtures" / "spherex_cutout_d6_wcs.fits"
CUTOUT_RA, CUTOUT_DEC = 269.451467, 4.693033


def _rotated_image_with_star(rotation_deg: float, size: int = 100) -> tuple[np.ndarray, WCS]:
    """Synthetic exposure, rotated like a real SPHEREx visit, with a star exactly on the target."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [size / 2, size / 2]
    scale = 6.15 / 3600
    theta = np.radians(rotation_deg)
    wcs.wcs.cd = scale * np.array([[-np.cos(theta), np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    y, x = np.mgrid[:size, :size]
    star_x, star_y = wcs.wcs.crpix[0] - 1, wcs.wcs.crpix[1] - 1
    data = 100 * np.exp(-((x - star_x) ** 2 + (y - star_y) ** 2) / (2 * 1.5**2)) + 5.0
    return data, wcs


def test_alignment_puts_the_target_in_the_centre_for_any_rotation():
    target, shape = target_grid(RA, DEC, 0.1)
    centre = (shape[0] - 1) / 2

    for rotation in (0, 30, 135):
        data, wcs = _rotated_image_with_star(rotation)
        aligned = align(data, np.ones(data.shape), wcs, target, shape)

        assert aligned.covered.all()
        peak = np.unravel_index(np.nanargmax(aligned.image), shape)
        assert abs(peak[0] - centre) <= 1
        assert abs(peak[1] - centre) <= 1


def test_partial_overlap_reports_coverage_and_masks_the_rest():
    data, wcs = _rotated_image_with_star(0, size=40)
    target, shape = target_grid(RA + 0.05, DEC, 0.1)

    aligned = align(data, np.ones(data.shape), wcs, target, shape)

    assert 0 < aligned.covered.mean() < 1
    assert (np.isnan(aligned.image) == ~aligned.covered).all()
    assert (np.isnan(aligned.variance) == ~aligned.covered).all()


def test_alignment_carries_the_variance_and_keeps_masked_pixels_nan():
    data, wcs = _rotated_image_with_star(30)
    variance = np.full(data.shape, 0.01)
    data[50, 60] = variance[50, 60] = np.nan  # masked by read_image
    target, shape = target_grid(RA, DEC, 0.1)

    aligned = align(data, variance, wcs, target, shape)

    assert aligned.covered.all()
    holes = np.argwhere(np.isnan(aligned.image))
    assert len(holes) >= 1
    assert (np.isnan(aligned.variance) == np.isnan(aligned.image)).all()
    assert np.nanmax(np.abs(aligned.variance - 0.01)) < 1e-9
    # Bilinear: the masked pixel blanks only the grid pixels whose interpolation it enters.
    x, y = target.world_to_pixel_values(*wcs.pixel_to_world_values(60, 50))
    assert np.hypot(holes[:, 1] - x, holes[:, 0] - y).max() <= np.sqrt(2)


def test_stars_do_not_lift_the_sky_level():
    target, shape = target_grid(RA, DEC, 0.1)
    rng = np.random.default_rng(4)
    data = 5.0 + rng.normal(0.0, 1.0, shape)
    stars = rng.random(shape) < 0.1
    data[stars] += 100.0

    aligned = align(data, np.ones(shape), target, target, shape)

    # A plain median would sit 0.14σ high with 10 % star pixels; the clipped one stays on the sky.
    assert abs(np.median(aligned.image[~stars])) < 0.04


def test_frames_share_one_stretch(tmp_path):
    names = render_png([np.zeros((20, 20)), np.full((20, 20), 10.0)], tmp_path)

    assert names == ["frame_00.png", "frame_01.png"]
    dark, bright = (np.asarray(Image.open(tmp_path / name)) for name in names)
    assert dark.mean() < bright.mean()


def _star(x: int, y: int, size: int = 64) -> np.ndarray:
    yy, xx = np.mgrid[:size, :size]
    return 100 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.5**2))


def test_a_moving_star_leaves_a_red_blue_pair_on_grey(tmp_path):
    earlier, later = _star(20, 20), _star(24, 20)
    later[:, 0] = np.nan

    render_diff(earlier, later, tmp_path, "diff_00_01.png")

    rgb = np.flipud(np.asarray(Image.open(tmp_path / "diff_00_01.png"))).astype(int)
    assert rgb.shape == (64, 64, 3)
    assert tuple(rgb[20, 20]) == (214, 64, 48)
    assert tuple(rgb[20, 24]) == (52, 112, 219)
    assert tuple(rgb[50, 50]) == (128, 128, 128)
    assert tuple(rgb[10, 0]) == (40, 40, 40)


def test_identical_epochs_give_a_plain_grey_difference(tmp_path):
    render_diff(np.ones((8, 8)), np.ones((8, 8)), tmp_path, "diff.png")

    assert (np.asarray(Image.open(tmp_path / "diff.png")) == 128).all()


def test_wavelength_at_the_target_comes_from_the_lookup_table():
    wavelength, bandwidth = wavelength_at(CUTOUT_HEADER, CUTOUT_RA, CUTOUT_DEC)

    # Bilinear interpolation of the WCS-WAVE control points around raw pixel (770.5, 1684.5).
    assert wavelength == pytest.approx(4.5022, abs=5e-4)
    assert bandwidth == pytest.approx(0.0355, abs=5e-4)


@pytest.mark.parametrize("missing", ["table", "header"])
def test_cutout_without_spectral_wcs_has_no_wavelength(tmp_path, missing):
    with fits.open(CUTOUT_HEADER) as hdul:
        if missing == "table":
            hdul = hdul[:2]
        else:
            del hdul["IMAGE"].header["CTYPE1W"]
        hdul.writeto(tmp_path / "plain.fits")

    assert wavelength_at(tmp_path / "plain.fits", CUTOUT_RA, CUTOUT_DEC) == (None, None)


@pytest.mark.parametrize("detector", [1, 4, 6])
def test_frames_compare_within_one_resolution_element(detector):
    step = 1 / frames.R_BY_DETECTOR[detector]

    assert comparable_wavelengths(2.0, 2.0 * (1 + 0.9 * step), detector)
    assert not comparable_wavelengths(2.0, 2.0 * (1 + 1.1 * step), detector)


def _client(responses: list[httpx.Response], calls: list[int]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return responses[len(calls) - 1]

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_busy_archive_is_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(frames.time, "sleep", lambda _: None)
    calls: list[int] = []
    busy = httpx.Response(503, text="Server busy, retry later.")
    client = _client([busy, busy, httpx.Response(200, content=b"FITS")], calls)

    path = frames.fetch_cutout(client, "https://irsa.example/cutout.fits", tmp_path)

    assert path.read_bytes() == b"FITS"
    assert len(calls) == 3
    assert not list(tmp_path.glob("*.part"))


def test_missing_file_is_not_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(frames.time, "sleep", lambda _: None)
    calls: list[int] = []
    client = _client([httpx.Response(404)], calls)

    with pytest.raises(httpx.HTTPStatusError):
        frames.fetch_cutout(client, "https://irsa.example/missing.fits", tmp_path)

    assert len(calls) == 1
    assert not list(tmp_path.iterdir())


def _cutout(path, flags: np.ndarray | None, data: np.ndarray | None = None) -> None:
    """Minimal SPHEREx-like cutout: IMAGE, VARIANCE and an optional FLAGS plane with mask bits."""
    _, wcs = _rotated_image_with_star(0, size=8)
    if data is None:
        data = np.ones((8, 8))
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(data.astype(np.float32), wcs.to_header())]
    hdus[1].name = "IMAGE"
    hdus.append(fits.ImageHDU(np.full((8, 8), 0.25, dtype=np.float32), name="VARIANCE"))
    if flags is not None:
        header = fits.Header()
        for plane, name in ((0, "TRANSIENT"), (10, "HOT"), (21, "SOURCE")):
            header[f"MSKN{plane:04d}"] = name
            header[f"MSKM{plane:04d}"] = 1 << plane
        hdus.append(fits.ImageHDU(flags.astype(np.int32), header, name="FLAGS"))
    fits.HDUList(hdus).writeto(path)


def test_unusable_flagged_pixels_stay_nan_in_image_and_variance(tmp_path):
    data = np.ones((8, 8))
    flags = np.zeros((8, 8), dtype=np.int32)
    for row, col, flag in ((1, 2, 1 << 0), (5, 5, 1 << 10), (6, 1, (1 << 21) | (1 << 0))):
        data[row, col] = 100.0  # transient, hot pixel, known source hit by a transient
        flags[row, col] = flag
    data[3, 3], flags[3, 3] = 100.0, 1 << 21  # SOURCE: informative, stays
    _cutout(tmp_path / "cutout.fits", flags, data)

    image, variance, _, unusable = read_image(tmp_path / "cutout.fits")

    assert np.argwhere(unusable).tolist() == [[1, 2], [5, 5], [6, 1]]
    assert (np.isnan(image) == unusable).all()
    assert (np.isnan(variance) == unusable).all()
    assert image[3, 3] == 100.0
    assert variance[3, 3] == 0.25


def test_only_the_blink_fills_masked_pixels_from_their_neighbours():
    image = np.ones((8, 8))
    image[1:6, 1:6] = np.nan  # masked inside the footprint
    image[:, 7] = np.nan  # outside the footprint
    covered = np.ones((8, 8), dtype=bool)
    covered[:, 7] = False
    frame = Aligned(image, np.where(np.isnan(image), np.nan, 0.25), covered)

    shown = for_display(frame)

    assert np.isnan(shown[3, 3])  # its whole neighbourhood is masked: renders black
    assert (shown[1:6, 1:6][~np.isnan(shown[1:6, 1:6])] == 1.0).all()
    assert np.isnan(shown[:, 7]).all()
    assert np.isnan(frame.image[1:6, 1:6]).all()  # the measured frame stays untouched


def test_cutout_without_flags_is_left_untouched(tmp_path):
    _cutout(tmp_path / "cutout.fits", None)

    image, variance, _, unusable = read_image(tmp_path / "cutout.fits")

    assert (image == 1.0).all()
    assert (variance == 0.25).all()
    assert not unusable.any()


def test_target_is_flagged_only_within_two_pixels_of_the_target():
    _, wcs = _rotated_image_with_star(30, size=21)
    unusable = np.zeros((21, 21), dtype=bool)
    assert not target_is_flagged(unusable, wcs, RA, DEC)

    unusable[10 + 2, 10] = True
    assert target_is_flagged(unusable, wcs, RA, DEC)
    assert not target_is_flagged(unusable, wcs, RA + 1.0, DEC)

    unusable[10 + 2, 10], unusable[10 + 3, 10] = False, True
    assert not target_is_flagged(unusable, wcs, RA, DEC)


_REQUEST = httpx.Request("GET", "https://irsa.example/cutout.fits")


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (
            httpx.HTTPStatusError("busy", request=_REQUEST, response=httpx.Response(503)),
            "HTTP 503 Service Unavailable, after 5 attempts",
        ),
        (
            httpx.HTTPStatusError("gone", request=_REQUEST, response=httpx.Response(404)),
            "HTTP 404 Not Found, not retried",
        ),
        (httpx.ReadTimeout("slow"), "no answer within 90 s, after 5 attempts"),
        (httpx.ConnectError("refused"), "ConnectError, after 5 attempts"),
    ],
)
def test_failure_reason_names_the_answer_or_timeout_and_the_retries(error, reason):
    assert frames.failure_reason(error, 90.0) == reason
