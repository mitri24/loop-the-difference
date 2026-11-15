"""Cutouts assembled from the public S3 copies of the SPHEREx Level-2 files.

IRSA's cutout service takes 3-15 s per cutout and answers "503 Server busy" to parallel requests.
The same files lie on S3 (bucket nasa-irsa-spherex, anonymous HTTPS, a byte range in ~0.3 s), so a
cutout is fetched as a few ranges: the window's rows of the IMAGE, FLAGS and VARIANCE planes, the
WCS-WAVE table, and the EPSF table once per detector and pipeline version (a calibration table,
identical in every exposure of a detector). The result is written like IRSA's cutout: the same
headers with NAXIS and every CRPIX moved to the window, EPSF and WCS-WAVE appended unchanged
(ZODI is left out, nothing reads it). The IRSA cutout URL stays the cache key and the provenance;
anything S3 cannot deliver falls back to the IRSA service.
"""

import io
import math
import os
import re
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlunsplit

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning, NoConvergence
from astropy.wcs.utils import proj_plane_pixel_scales

IRSA_DATA = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
S3_DATA = "https://nasa-irsa-spherex.s3.amazonaws.com/"
BLOCK = 2880
CARD = 80
END_CARD = b"END" + b" " * (CARD - 3)
# One header read: PRIMARY plus the 275-card IMAGE header of a Level-2 file fit in 10 blocks.
HEADER_CHUNK = 10 * BLOCK
MAX_HEADER = 100 * BLOCK
# Pixels around the requested size, so the frame covers the target grid like IRSA's cutout does.
MARGIN_PX = 4
PLANES = ("IMAGE", "FLAGS", "VARIANCE")
TABLES = ("EPSF", "WCS-WAVE")
_CRPIX = re.compile(r"CRPIX([12])([A-Z]?)")

# The HDUs after IMAGE per (pipeline VERSION, detector): (EXTNAME, header bytes, data bytes,
# bytes per table or pixel row). Exposures of one kind differ only in their IMAGE WCS, so the
# layout of the first one predicts the rest, and later files need one header read instead of a
# walk through the HDUs. The data of a tile-compressed plane (FLAGS, Rice, one row per tile) is
# as long as it compresses: None, and the HDUs behind it are placed from the end of the file.
Layout = list[tuple[str, int, int | None, int]]
_LAYOUTS: dict[tuple[str, int], Layout] = {}


class NotFromS3(Exception):
    """S3 cannot deliver this cutout: the IRSA cutout service is asked instead."""


class OutsideFrame(NotFromS3):
    """The requested window does not touch the exposure."""


class LayoutMismatch(NotFromS3):
    """A guessed HDU position was wrong: the file's HDUs must be walked."""


def parse_cutout_url(url: str) -> tuple[str, float, float, float]:
    """Access URL, centre and size (deg) a cutout URL from frames.cutout_url was built from."""
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    ra, dec = (float(value) for value in query["center"][0].split(","))
    return urlunsplit(parts._replace(query="", fragment="")), ra, dec, float(query["size"][0])


def s3_url(access_url: str) -> str | None:
    """The same Level-2 file on S3, or None when the access URL is not an IRSA SPHEREx file."""
    if not access_url.startswith(IRSA_DATA):
        return None
    return S3_DATA + access_url[len(IRSA_DATA) :]


def fetch_from_s3(client: httpx.Client, url: str, path: Path) -> bool:
    """Write the cutout `url` names to `path` from S3; False when S3 cannot serve it."""
    try:
        access_url, ra, dec, size_deg = parse_cutout_url(url)
    except (KeyError, ValueError):
        return False
    source = s3_url(access_url)
    if source is None:
        return False
    try:
        _assemble(client, source, ra, dec, size_deg, path)
    except (httpx.HTTPError, NotFromS3, ValueError, KeyError):
        return False
    return True


def pixel_window(header: fits.Header, ra: float, dec: float, size_deg: float) -> tuple:
    """0-based inclusive pixel bounds (x0, x1, y0, y1) of a size_deg cutout around (ra, dec)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs = WCS(header)
        try:
            x, y = (float(value) for value in wcs.world_to_pixel_values(ra, dec))
        except NoConvergence as exc:
            raise OutsideFrame("target far outside the exposure") from exc
    if not (math.isfinite(x) and math.isfinite(y)):
        raise OutsideFrame("target not on the exposure's projection")
    half = size_deg / (2 * float(np.mean(proj_plane_pixel_scales(wcs)))) + MARGIN_PX
    width, height = int(header["NAXIS1"]), int(header["NAXIS2"])
    x0, x1 = max(math.floor(x - half), 0), min(math.ceil(x + half), width - 1)
    y0, y1 = max(math.floor(y - half), 0), min(math.ceil(y + half), height - 1)
    if x0 > x1 or y0 > y1:
        raise OutsideFrame(f"window outside the {width}x{height} exposure")
    return x0, x1, y0, y1


class _Ranges:
    """Byte ranges of one S3 object; the object's size comes with the first answer."""

    def __init__(self, client: httpx.Client, url: str) -> None:
        self.client, self.url, self.size = client, url, 0

    def __call__(self, start: int, end: int) -> bytes:
        response = self.client.get(self.url, headers={"Range": f"bytes={start}-{end}"})
        total = response.headers.get("Content-Range", "").rpartition("/")[2]
        if response.status_code != 206 or not total.isdigit():
            raise NotFromS3(f"HTTP {response.status_code} for a byte range")
        self.size = int(total)
        if len(response.content) != min(end, self.size - 1) - start + 1:
            raise NotFromS3("byte range answered with another length")
        return response.content

    def parallel(self, ranges: dict[str, tuple[int, int]]) -> dict[str, bytes]:
        with ThreadPoolExecutor(len(ranges)) as pool:
            return dict(
                zip(ranges, pool.map(lambda span: self(*span), ranges.values()), strict=True)
            )


def _assemble(client, source: str, ra: float, dec: float, size_deg: float, path: Path) -> None:
    fetch = _Ranges(client, source)
    head = fetch(0, HEADER_CHUNK - 1)
    primary, offset = _read_header(fetch, 0, head)
    image, image_data = _read_header(fetch, offset, head[offset:])
    window = pixel_window(image, ra, dec, size_deg)
    key = (str(primary.get("VERSION", "")), int(image.get("DETECTOR", 0)))
    after_image = image_data + _data_bytes(image)
    epsf_path = path.parent / "epsf" / f"epsf_{key[1]}_{key[0]}.hdu"
    try:
        if key not in _LAYOUTS:
            raise LayoutMismatch("first file of this kind")
        parts = _fetch_parts(
            fetch, image, image_data, after_image, _LAYOUTS[key], window, epsf_path
        )
    except LayoutMismatch:
        _LAYOUTS[key] = _walk(fetch, after_image)
        parts = _fetch_parts(
            fetch, image, image_data, after_image, _LAYOUTS[key], window, epsf_path
        )
    _write(path, primary, *parts, window)


def _read_header(fetch: _Ranges, offset: int, raw: bytes = b"") -> tuple[fits.Header, int]:
    """The header at `offset` (`raw` may hold its first bytes) and where its data starts."""
    while (length := _header_bytes(raw)) is None:
        if len(raw) >= MAX_HEADER:
            raise NotFromS3("no END card")
        raw += fetch(offset + len(raw), offset + len(raw) + HEADER_CHUNK - 1)
    return fits.Header.fromstring(raw[:length]), offset + length


def _header_bytes(raw: bytes) -> int | None:
    """Padded length of the header that starts `raw`, or None when its END card is not in it."""
    for at in range(0, len(raw) - CARD + 1, CARD):
        if raw[at : at + CARD] == END_CARD:
            return _padded(at + CARD)
    return None


def _padded(length: int) -> int:
    return -(-length // BLOCK) * BLOCK


def _data_bytes(header: fits.Header) -> int:
    """Padded length of the data that follows `header` (FITS standard, section 4.4.1)."""
    axes = int(header["NAXIS"])
    if axes == 0:
        return 0
    pixels = math.prod(int(header[f"NAXIS{i}"]) for i in range(1, axes + 1))
    groups, parameters = int(header.get("GCOUNT", 1)), int(header.get("PCOUNT", 0))
    return _padded(abs(int(header["BITPIX"])) // 8 * groups * (parameters + pixels))


def _compressed(header: fits.Header) -> bool:
    return bool(header.get("ZIMAGE"))


def _row_bytes(header: fits.Header) -> int:
    """Bytes per row: of the tile table for a compressed plane, of the pixels otherwise."""
    if _compressed(header):
        return int(header["NAXIS1"])
    return abs(int(header["BITPIX"])) // 8 * int(header["NAXIS1"])


def _width(header: fits.Header) -> int:
    return int(header["ZNAXIS1" if _compressed(header) else "NAXIS1"])


def _walk(fetch: _Ranges, offset: int) -> Layout:
    """Read the headers of the HDUs from `offset` to the end of the file."""
    layout: Layout = []
    while offset < fetch.size:
        header, data_start = _read_header(fetch, offset)
        data = _data_bytes(header)
        fixed = None if _compressed(header) else data
        layout.append((str(header["EXTNAME"]), data_start - offset, fixed, _row_bytes(header)))
        offset = data_start + data
    return layout


def _place(layout: Layout, after_image: int, size: int) -> dict[str, int]:
    """Where each HDU after IMAGE starts: counted from the front up to the first HDU of varying
    length, from the end of the file for those behind it."""
    place, at = {}, after_image
    for name, header_bytes, data_bytes, _ in layout:
        place[name] = at
        if data_bytes is None:
            break
        at += header_bytes + data_bytes
    at = size
    for name, header_bytes, data_bytes, _ in reversed(layout):
        if data_bytes is None:
            break
        at -= header_bytes + data_bytes
        place[name] = at
    return place


def _fetch_parts(fetch, image, image_data, after_image, layout, window, epsf_path):
    """The planes' headers and window pixels and the raw table HDUs, all ranges in parallel."""
    x0, x1, y0, y1 = window
    width = int(image["NAXIS1"])
    place = _place(layout, after_image, fetch.size)
    info = {
        name: (header_bytes, data_bytes, row_bytes)
        for name, header_bytes, data_bytes, row_bytes in layout
    }
    for name in PLANES[1:]:
        if name not in place:
            raise NotFromS3(f"no {name} plane")
    ranges = {"IMAGE": _row_range(image_data, _row_bytes(image), y0, y1)}
    for name in PLANES[1:]:
        start, (header_bytes, _, row_bytes) = place[name], info[name]
        ranges[name + " header"] = (start, start + header_bytes - 1)
        ranges[name] = _row_range(start + header_bytes, row_bytes, y0, y1)
    for name in TABLES:
        if name in place and not (name == "EPSF" and epsf_path.exists()):
            header_bytes, data_bytes, _ = info[name]
            if data_bytes is None:
                raise NotFromS3(f"{name} table of varying length")
            ranges[name] = (place[name], place[name] + header_bytes + data_bytes - 1)
    raw = fetch.parallel(ranges)
    planes = [(image, _rows(raw["IMAGE"], image, window))]
    for name in PLANES[1:]:
        header_bytes, _, row_bytes = info[name]
        header = _extension(raw[name + " header"], name, header_bytes)
        if _row_bytes(header) != row_bytes or _width(header) != width:
            raise LayoutMismatch(f"{name} plane differs from the memoized layout")
        if _compressed(header):
            header, rows = _decompress(fetch, header, raw[name], place[name] + header_bytes)
            planes.append((header, rows[:, x0 : x1 + 1].copy()))
        else:
            planes.append((header, _rows(raw[name], header, window)))
    tables = []
    for name in TABLES:
        if name not in place:
            continue
        if name not in raw:
            tables.append(epsf_path.read_bytes())
            continue
        _extension(raw[name], name, info[name][0])
        if name == "EPSF":
            _write_cached(epsf_path, raw[name])
        tables.append(raw[name])
    return planes, tables


def _row_range(data_start: int, row_bytes: int, y0: int, y1: int) -> tuple[int, int]:
    return data_start + y0 * row_bytes, data_start + (y1 + 1) * row_bytes - 1


def _rows(raw: bytes, header: fits.Header, window: tuple) -> np.ndarray:
    """The window's pixels out of the raw rows y0..y1 of a plane (big-endian, FITS order)."""
    x0, x1, y0, y1 = window
    bitpix = int(header["BITPIX"])
    dtype = np.dtype((">f" if bitpix < 0 else ">i") + str(abs(bitpix) // 8))
    width = int(header["NAXIS1"])
    return np.frombuffer(raw, dtype).reshape(y1 - y0 + 1, width)[:, x0 : x1 + 1].copy()


def _decompress(
    fetch, header, descriptors: bytes, data_start: int
) -> tuple[fits.Header, np.ndarray]:
    """Rows of a tile-compressed plane: their tiles' (length, offset) descriptors point into the
    heap, whose span is fetched and decoded by astropy as a small compressed image of just these
    rows. Returns the plane's image header and the rows' pixels."""
    if int(header["ZTILE1"]) != int(header["ZNAXIS1"]) or int(header.get("ZTILE2", 1)) != 1:
        raise NotFromS3("compressed tiles are not single rows")
    tiles = np.frombuffer(descriptors, ">i4").reshape(-1, 2).copy()
    heap = data_start + int(header.get("THEAP", int(header["NAXIS1"]) * int(header["NAXIS2"])))
    first, last = int(tiles[:, 1].min()), int((tiles[:, 1] + tiles[:, 0]).max())
    chunk = fetch(heap + first, heap + last - 1)
    tiles[:, 1] -= first
    small = header.copy()
    small["NAXIS2"] = small["ZNAXIS2"] = len(tiles)
    small["PCOUNT"] = len(chunk)
    small.remove("THEAP", ignore_missing=True)
    body = tiles.tobytes() + chunk
    raw = fits.PrimaryHDU().header.tostring().encode() + small.tostring().encode()
    with fits.open(io.BytesIO(raw + body + b"\0" * (-len(body) % BLOCK))) as hdul:
        return hdul[1].header.copy(), np.ascontiguousarray(hdul[1].data)


def _extension(raw: bytes, name: str, header_bytes: int) -> fits.Header:
    """The header at the start of `raw`, if it is the expected extension where it was guessed."""
    if not raw.startswith(b"XTENSION") or _header_bytes(raw[:header_bytes]) != header_bytes:
        raise LayoutMismatch(f"no {name} header at the memoized position")
    header = fits.Header.fromstring(raw[:header_bytes])
    if header.get("EXTNAME") != name:
        raise LayoutMismatch(f"{header.get('EXTNAME')} found where {name} was expected")
    return header


def _write(path: Path, primary: fits.Header, planes, tables, window: tuple) -> None:
    """The cutout as IRSA's service writes it: headers copied, NAXIS and CRPIX moved to the
    window."""
    x0, _, y0, _ = window
    hdus = [fits.PrimaryHDU(header=primary)]
    for header, pixels in planes:
        header = header.copy()
        for key in list(header):
            if match := _CRPIX.fullmatch(key):
                header[key] = header[key] - (x0 if match[1] == "1" else y0)
        hdus.append(fits.ImageHDU(pixels, header))
    partial = path.with_name(f"{path.name}.{os.getpid()}-{id(planes)}.part")
    path.parent.mkdir(parents=True, exist_ok=True)
    with partial.open("wb") as file:
        fits.HDUList(hdus).writeto(file)
        for raw in tables:
            file.write(raw)
    partial.replace(path)


def _write_cached(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.{os.getpid()}-{id(content)}.part")
    partial.write_bytes(content)
    partial.replace(path)
