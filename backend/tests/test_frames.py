from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from app import frames
from app.frames import (
    align,
    comparable_wavelengths,
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
        image, coverage = align(*_rotated_image_with_star(rotation), target, shape)

        assert coverage == 1.0
        peak = np.unravel_index(np.nanargmax(image), image.shape)
        assert abs(peak[0] - centre) <= 1
        assert abs(peak[1] - centre) <= 1


def test_partial_overlap_reports_coverage_and_masks_the_rest():
    data, wcs = _rotated_image_with_star(0, size=40)
    target, shape = target_grid(RA + 0.05, DEC, 0.1)

    image, coverage = align(data, wcs, target, shape)

    assert 0 < coverage < 1
    assert np.isnan(image).sum() == round((1 - coverage) * image.size)


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
    """Minimal SPHEREx-like cutout: IMAGE plus an optional FLAGS plane with named mask bits."""
    _, wcs = _rotated_image_with_star(0, size=8)
    if data is None:
        data = np.ones((8, 8))
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(data.astype(np.float32), wcs.to_header())]
    hdus[1].name = "IMAGE"
    if flags is not None:
        header = fits.Header()
        for plane, name in ((0, "TRANSIENT"), (10, "HOT"), (21, "SOURCE")):
            header[f"MSKN{plane:04d}"] = name
            header[f"MSKM{plane:04d}"] = 1 << plane
        hdus.append(fits.ImageHDU(flags.astype(np.int32), header, name="FLAGS"))
    fits.HDUList(hdus).writeto(path)


def test_unusable_flagged_pixels_take_the_median_of_their_neighbours(tmp_path):
    data = np.ones((8, 8))
    flags = np.zeros((8, 8), dtype=np.int32)
    for row, col, flag in ((1, 2, 1 << 0), (5, 5, 1 << 10), (6, 1, (1 << 21) | (1 << 0))):
        data[row, col] = 100.0  # transient, hot pixel, known source hit by a transient
        flags[row, col] = flag
    data[3, 3], flags[3, 3] = 100.0, 1 << 21  # SOURCE: informative, stays
    _cutout(tmp_path / "cutout.fits", flags, data)

    image, _, unusable = read_image(tmp_path / "cutout.fits")

    assert np.argwhere(unusable).tolist() == [[1, 2], [5, 5], [6, 1]]
    assert image[1, 2] == image[5, 5] == image[6, 1] == 1.0
    assert image[3, 3] == 100.0
    assert not np.isnan(image).any()


def test_pixel_without_usable_neighbours_stays_nan(tmp_path):
    flags = np.zeros((8, 8), dtype=np.int32)
    flags[1:6, 1:6] = 1 << 10
    _cutout(tmp_path / "cutout.fits", flags)

    image, _, unusable = read_image(tmp_path / "cutout.fits")

    assert np.isnan(image[3, 3])
    assert np.isnan(image).sum() == 1
    assert unusable.sum() == 25


def test_cutout_without_flags_is_left_untouched(tmp_path):
    _cutout(tmp_path / "cutout.fits", None)

    image, _, unusable = read_image(tmp_path / "cutout.fits")

    assert (image == 1.0).all()
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
