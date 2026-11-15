"""Cutouts assembled from S3 byte ranges must be what IRSA's cutout service would deliver."""

import io
import warnings

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from app import cutouts, frames
from app.cutouts import (
    IRSA_DATA,
    OutsideFrame,
    fetch_from_s3,
    parse_cutout_url,
    pixel_window,
    s3_url,
)
from app.frames import cutout_url, wavelength_at
from app.psf import cutout_epsf

S3_HOST = "nasa-irsa-spherex.s3.amazonaws.com"
WIDTH, HEIGHT = 60, 50
RA0, DEC0 = 150.0, 20.0
SCALE_DEG = 6.15 / 3600
KEY = "dr1/level2/x/level2_test_D6.fits"


@pytest.fixture(autouse=True)
def fresh_layouts(monkeypatch):
    """The HDU layout memo is per process: every test starts without one."""
    monkeypatch.setattr(cutouts, "_LAYOUTS", {})


def _image_header(extra_flags_cards: int = 0) -> fits.Header:
    """TAN-SIP sky WCS, the 'A' detector pixel WCS and the 'W' WAVE-TAB WCS of a Level-2 file."""
    header = fits.Header()
    header["DETECTOR"] = 6
    header["OBSID"] = "test_0001_1"
    header["WCSAXES"] = 2
    header["CRPIX1"], header["CRPIX2"] = 30.5, 25.5
    header["PC1_1"], header["PC1_2"] = -SCALE_DEG * 0.96, SCALE_DEG * 0.28
    header["PC2_1"], header["PC2_2"] = SCALE_DEG * 0.28, SCALE_DEG * 0.96
    header["CDELT1"] = header["CDELT2"] = 1.0
    header["CUNIT1"] = header["CUNIT2"] = "deg"
    header["CTYPE1"], header["CTYPE2"] = "RA---TAN-SIP", "DEC--TAN-SIP"
    header["CRVAL1"], header["CRVAL2"] = RA0, DEC0
    header["A_ORDER"] = header["B_ORDER"] = 2
    header["A_2_0"], header["A_0_2"], header["B_2_0"], header["B_0_2"] = 2e-5, 1e-5, 1e-5, 2e-5
    header["WCSAXESA"] = 2
    header["CRPIX1A"] = header["CRPIX2A"] = 1.0
    header["CDELT1A"] = header["CDELT2A"] = 1.0
    header["CTYPE1A"] = header["CTYPE2A"] = "LINEAR"
    header["CRVAL1A"] = header["CRVAL2A"] = 0.0
    header["WCSAXESW"] = 2
    header["CRPIX1W"] = header["CRPIX2W"] = 1
    header["CDELT1W"] = header["CDELT2W"] = 1
    header["CUNIT1W"] = header["CUNIT2W"] = "um"
    header["CTYPE1W"] = header["CTYPE2W"] = "WAVE-TAB"
    header["CRVAL1W"] = header["CRVAL2W"] = 1
    header["PV1_3W"], header["PV2_3W"] = 1, 2
    header["PS1_0W"] = header["PS2_0W"] = "WCS-WAVE"
    header["PS1_1W"] = header["PS2_1W"] = "VALUES"
    header["PS1_2W"], header["PS2_2W"] = "X", "Y"
    for i in range(extra_flags_cards):
        header[f"MSKN{i:04d}"] = f"PLANE{i}"
    return header


def _epsf_table() -> fits.BinTableHDU:
    """Four ePSF zones with the columns psf.py reads, each a Gaussian of its own width."""
    centres = [(15.0, 12.5), (45.0, 12.5), (15.0, 37.5), (45.0, 37.5)]
    yy, xx = np.mgrid[:33, :33] - 16.0
    stamps = np.stack(
        [np.exp(-(xx**2 + yy**2) / (2 * (4.0 + i) ** 2)) for i in range(len(centres))]
    )
    stamps /= stamps.sum(axis=(1, 2))[:, None, None]
    n = len(centres)
    columns = [
        fits.Column("BINX", "J", array=np.array([0, 1, 0, 1])),
        fits.Column("BINY", "J", array=np.array([0, 0, 1, 1])),
        fits.Column("XCENTER", "E", array=np.array([c[0] for c in centres])),
        fits.Column("YCENTER", "E", array=np.array([c[1] for c in centres])),
        fits.Column("XWIDTH", "E", array=np.full(n, 30.0)),
        fits.Column("YWIDTH", "E", array=np.full(n, 25.0)),
        fits.Column("NSTAR", "J", array=np.full(n, 40)),
        fits.Column("NEFF_MEAN", "E", array=np.full(n, 5.2)),
        fits.Column("CWAVE", "E", array=np.full(n, 4.6)),
        fits.Column("CBAND", "E", array=np.full(n, 0.035)),
        fits.Column("EPSF", "1089D", dim="(33,33)", array=stamps),
    ]
    table = fits.BinTableHDU.from_columns(columns, name="EPSF")
    table.header["OVSMPX"] = table.header["OVSMPY"] = 5
    return table


def _wave_table() -> fits.BinTableHDU:
    """WAVE-TAB lookup: wavelength grows along x, bandwidth along y, 3 × 3 control points."""
    xs, ys = np.array([1, WIDTH // 2, WIDTH]), np.array([1, HEIGHT // 2, HEIGHT])
    values = np.zeros((3, 3, 2), dtype=np.float32)
    for j in range(3):
        for i in range(3):
            values[j, i] = (4.0 + 0.1 * i, 0.03 + 0.01 * j)
    columns = [
        fits.Column("X", "3J", array=xs[None]),
        fits.Column("Y", "3J", array=ys[None]),
        fits.Column("VALUES", "18E", dim="(2,3,3)", array=values[None]),
    ]
    return fits.BinTableHDU.from_columns(columns, name="WCS-WAVE")


def _full_frame(
    seed: int = 0, extra_flags_cards: int = 0, compressed_flags: bool = True
) -> tuple[bytes, fits.HDUList]:
    """A synthetic Level-2 file as bytes, with the HDU order of the real ones; like them, FLAGS
    is Rice-compressed one row per tile unless asked otherwise."""
    rng = np.random.default_rng(seed)
    header = _image_header()
    image = rng.normal(size=(HEIGHT, WIDTH)).astype(np.float32)
    image[7, 9] = np.nan
    flags = rng.integers(0, 2**10, size=(HEIGHT, WIDTH)).astype(np.int32)
    variance = rng.uniform(0.5, 2.0, size=(HEIGHT, WIDTH)).astype(np.float32)
    zodi = np.full((HEIGHT, WIDTH), 3.0, dtype=np.float32)
    primary = fits.PrimaryHDU()
    primary.header["VERSION"] = "1.0-test"
    flags_header = _image_header(extra_flags_cards)
    if compressed_flags:
        flags_hdu = fits.CompImageHDU(flags, flags_header, name="FLAGS", tile_shape=(1, WIDTH))
    else:
        flags_hdu = fits.ImageHDU(flags, flags_header, name="FLAGS")
    hdul = fits.HDUList(
        [
            primary,
            fits.ImageHDU(image, header, name="IMAGE"),
            flags_hdu,
            fits.ImageHDU(variance, header, name="VARIANCE"),
            fits.ImageHDU(zodi, header, name="ZODI"),
            _epsf_table(),
            _wave_table(),
        ]
    )
    buffer = io.BytesIO()
    hdul.writeto(buffer)
    # Read back from the bytes: the file's byte order and the decompressed FLAGS, like a reader.
    return buffer.getvalue(), fits.open(io.BytesIO(buffer.getvalue()))


class FakeArchive:
    """S3 answering byte ranges and the IRSA cutout service, on one MockTransport."""

    def __init__(self, files: dict[str, bytes], irsa: list[httpx.Response] | None = None):
        self.files = files
        self.irsa = irsa or []
        self.served: list[tuple[httpx.Request, httpx.Response]] = []
        self.ranges = True

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self._handle))

    def requests(self, host: str) -> list[httpx.Request]:
        return [request for request, _ in self.served if request.url.host == host]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        response = self._s3(request) if request.url.host == S3_HOST else self.irsa.pop(0)
        self.served.append((request, response))
        return response

    def _s3(self, request: httpx.Request) -> httpx.Response:
        data = self.files.get(request.url.path.lstrip("/"))
        wanted = request.headers.get("Range")
        if data is None:
            return httpx.Response(404)
        if not self.ranges or wanted is None:
            return httpx.Response(200, content=data)
        start, end = (int(v) for v in wanted.removeprefix("bytes=").split("-"))
        if start >= len(data):
            return httpx.Response(416)
        end = min(end, len(data) - 1)
        content_range = f"bytes {start}-{end}/{len(data)}"
        return httpx.Response(
            206, content=data[start : end + 1], headers={"Content-Range": content_range}
        )


def _target(hdul: fits.HDUList, x: float, y: float) -> tuple[float, float]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        ra, dec = WCS(hdul["IMAGE"].header).pixel_to_world_values(x, y)
    return float(ra), float(dec)


def _url(key: str, ra: float, dec: float, size_deg: float = 0.02) -> str:
    return cutout_url(IRSA_DATA + key, ra, dec, size_deg)


def test_cutout_url_round_trips_and_only_irsa_spherex_files_have_an_s3_copy():
    url = cutout_url(IRSA_DATA + KEY, 150.123456, -20.5, 0.1)

    assert parse_cutout_url(url) == (IRSA_DATA + KEY, 150.123456, -20.5, 0.142)
    assert s3_url(IRSA_DATA + KEY) == f"https://{S3_HOST}/{KEY}"
    assert s3_url("https://irsa.invalid/100.fits") is None


@pytest.mark.parametrize("compressed_flags", [True, False])
def test_assembled_cutout_equals_the_window_of_the_full_frame(tmp_path, compressed_flags):
    data, full = _full_frame(compressed_flags=compressed_flags)
    archive = FakeArchive({KEY: data})
    ra, dec = _target(full, 35.3, 22.7)
    url = _url(KEY, ra, dec)
    path = tmp_path / "cutouts" / "a.fits"

    with archive.client() as client:
        assert fetch_from_s3(client, url, path)

    x0, x1, y0, y1 = pixel_window(full["IMAGE"].header, ra, dec, 0.02 * frames.ROTATION_MARGIN)
    assert 0 < x0 < x1 < WIDTH - 1 and 0 < y0 < y1 < HEIGHT - 1
    with fits.open(path) as cut:
        assert [hdu.name for hdu in cut] == [
            "PRIMARY",
            "IMAGE",
            "FLAGS",
            "VARIANCE",
            "EPSF",
            "WCS-WAVE",
        ]
        assert cut[0].header["VERSION"] == "1.0-test"
        for name in ("IMAGE", "FLAGS", "VARIANCE"):
            expected = full[name].data[y0 : y1 + 1, x0 : x1 + 1]
            assert (
                cut[name].data.dtype.str[1:] == expected.dtype.str[1:]
            )  # same type, any byte order
            assert np.array_equal(cut[name].data, expected, equal_nan=expected.dtype.kind == "f")
            header = cut[name].header
            assert header["XTENSION"] == "IMAGE" and "ZIMAGE" not in header
            assert (header["CRPIX1A"], header["CRPIX2A"]) == (1 - x0, 1 - y0)
            assert (header["CRPIX1W"], header["CRPIX2W"]) == (1 - x0, 1 - y0)
            assert header["CRPIX1"] == 30.5 - x0 and header["CRPIX2"] == 25.5 - y0
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            whole, window = WCS(full["IMAGE"].header), WCS(cut["IMAGE"].header)
        centre = ((x0 + x1) / 2, (y0 + y1) / 2)
        sky_full = whole.pixel_to_world_values(*centre)
        sky_cut = window.pixel_to_world_values(centre[0] - x0, centre[1] - y0)
        assert np.allclose(sky_full, sky_cut, atol=1e-9)
        assert cut["EPSF"].data.tobytes() == full["EPSF"].data.tobytes()
        assert cut["WCS-WAVE"].data.tobytes() == full["WCS-WAVE"].data.tobytes()
    # The spectral WCS and the ePSF lookup work on the assembled file as on IRSA's.
    full_path = tmp_path / "full.fits"
    full_path.write_bytes(data)
    assert wavelength_at(path, ra, dec) == pytest.approx(
        wavelength_at(full_path, ra, dec), abs=1e-6
    )
    model, _, shape = cutout_epsf(path, ra, dec)
    model_full, _, _ = cutout_epsf(full_path, ra, dec)
    assert shape == (y1 - y0 + 1, x1 - x0 + 1)
    assert np.allclose(model.data, model_full.data)
    assert not list(path.parent.glob("*.part"))


def test_epsf_is_fetched_once_and_the_layout_is_reused(tmp_path):
    data, full = _full_frame()
    other, _ = _full_frame(seed=1)
    archive = FakeArchive({KEY: data, "dr1/level2/x/level2_other_D6.fits": other})

    with archive.client() as client:
        assert fetch_from_s3(client, _url(KEY, *_target(full, 35.3, 22.7)), tmp_path / "a.fits")
        first = len(archive.served)
        url = _url("dr1/level2/x/level2_other_D6.fits", *_target(full, 20.0, 30.0))
        assert fetch_from_s3(client, url, tmp_path / "b.fits")

    big = [r for _, r in archive.served if len(r.content) > cutouts.HEADER_CHUNK]
    assert len(big) == 1, "the EPSF table is one range, fetched once per detector and version"
    assert (tmp_path / "epsf" / "epsf_6_1.0-test.hdu").exists()
    # Second file, no walk: PRIMARY+IMAGE header, IMAGE rows, FLAGS header + tile table + heap,
    # VARIANCE header + rows, WCS-WAVE.
    assert len(archive.served) - first == 8
    with fits.open(tmp_path / "b.fits") as cut:
        assert cut["EPSF"].data.tobytes() == full["EPSF"].data.tobytes()
        assert cut["IMAGE"].data.shape[0] > 10


def test_a_file_whose_layout_differs_from_the_memo_is_walked_again(tmp_path):
    data, full = _full_frame()
    longer, longer_full = _full_frame(seed=2, extra_flags_cards=40)
    archive = FakeArchive({KEY: data, "dr1/level2/x/level2_long_D6.fits": longer})
    ra, dec = _target(full, 35.3, 22.7)

    with archive.client() as client:
        assert fetch_from_s3(client, _url(KEY, ra, dec), tmp_path / "a.fits")
        assert fetch_from_s3(
            client, _url("dr1/level2/x/level2_long_D6.fits", ra, dec), tmp_path / "b.fits"
        )

    x0, x1, y0, y1 = pixel_window(full["IMAGE"].header, ra, dec, 0.02 * frames.ROTATION_MARGIN)
    with fits.open(tmp_path / "b.fits") as cut:
        assert np.array_equal(
            cut["FLAGS"].data, longer_full["FLAGS"].data[y0 : y1 + 1, x0 : x1 + 1]
        )
        assert cut["FLAGS"].header["MSKN0039"] == "PLANE39"
        assert np.array_equal(
            cut["VARIANCE"].data, longer_full["VARIANCE"].data[y0 : y1 + 1, x0 : x1 + 1]
        )


@pytest.mark.parametrize("failure", ["no ranges", "missing"])
def test_s3_that_cannot_serve_the_file_is_not_used(tmp_path, failure):
    data, full = _full_frame()
    archive = FakeArchive({} if failure == "missing" else {KEY: data})
    archive.ranges = failure != "no ranges"
    path = tmp_path / "a.fits"

    with archive.client() as client:
        assert not fetch_from_s3(client, _url(KEY, *_target(full, 35.3, 22.7)), path)

    assert not path.exists()
    assert not list(tmp_path.glob("*.part"))


def test_a_window_outside_the_frame_raises_and_falls_back(tmp_path):
    data, full = _full_frame()
    ra, dec = _target(full, 400.0, 22.7)

    with pytest.raises(OutsideFrame):
        pixel_window(full["IMAGE"].header, ra, dec, 0.02)
    archive = FakeArchive({KEY: data})
    with archive.client() as client:
        assert not fetch_from_s3(client, _url(KEY, ra, dec), tmp_path / "a.fits")


def test_a_window_at_the_edge_is_clipped_to_the_frame(tmp_path):
    data, full = _full_frame()
    ra, dec = _target(full, 2.0, 47.0)
    archive = FakeArchive({KEY: data})

    with archive.client() as client:
        assert fetch_from_s3(client, _url(KEY, ra, dec), tmp_path / "a.fits")

    x0, x1, y0, y1 = pixel_window(full["IMAGE"].header, ra, dec, 0.02 * frames.ROTATION_MARGIN)
    assert (x0, y1) == (0, HEIGHT - 1)
    with fits.open(tmp_path / "a.fits") as cut:
        assert cut["IMAGE"].data.shape == (y1 - y0 + 1, x1 - x0 + 1)
        assert np.array_equal(cut["IMAGE"].data, full["IMAGE"].data[y0:, : x1 + 1], equal_nan=True)


def test_fetch_cutout_falls_back_to_irsa_when_s3_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(frames.time, "sleep", lambda _: None)
    busy = httpx.Response(503, text="Server busy, retry later.")
    archive = FakeArchive({}, irsa=[busy, busy, httpx.Response(200, content=b"FITS")])
    url = _url(KEY, 150.0, 20.0)

    with archive.client() as client:
        path = frames.fetch_cutout(client, url, tmp_path)

    assert path.read_bytes() == b"FITS"
    assert len(archive.requests(S3_HOST)) == 1
    irsa = archive.requests("irsa.ipac.caltech.edu")
    assert len(irsa) == 3 and all(str(request.url) == url for request in irsa)
    assert not list(tmp_path.glob("*.part"))


def test_fetch_cutout_takes_the_s3_copy_without_asking_irsa(tmp_path):
    data, full = _full_frame()
    archive = FakeArchive({KEY: data})
    url = _url(KEY, *_target(full, 35.3, 22.7))

    with archive.client() as client:
        path = frames.fetch_cutout(client, url, tmp_path)

    assert path == frames.cutout_path(tmp_path, url)
    assert not archive.requests("irsa.ipac.caltech.edu")
    with fits.open(path) as cut:
        assert cut["IMAGE"].header["OBSID"] == "test_0001_1"


def test_other_archives_are_asked_directly(tmp_path):
    archive = FakeArchive({}, irsa=[httpx.Response(200, content=b"FITS")])
    url = cutout_url("https://irsa.invalid/100.fits", 150.0, 20.0, 0.02)

    with archive.client() as client:
        frames.fetch_cutout(client, url, tmp_path)

    assert not archive.requests(S3_HOST)
    assert len(archive.requests("irsa.invalid")) == 1
