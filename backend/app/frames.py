import hashlib
import os
import random
import re
import threading
import time
import warnings
from pathlib import Path
from typing import NamedTuple

import httpx
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS, FITSFixedWarning
from PIL import Image
from reproject import reproject_interp

SPHEREX_PIXEL_SCALE_ARCSEC = 6.15
# A cutout is aligned with the detector, the target grid with north: √2 covers any rotation.
ROTATION_MARGIN = 1.42
DOWNLOAD_ATTEMPTS = 5
RETRY_BASE_S = 2.0
# IRSA answers "503 Server busy, retry later" under load.
_RETRY_STATUS = {429, 500, 502, 503, 504}
# Spectral resolving power per detector as IRSA lists it for the spectral images (band N = DN),
# https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products; the median
# λ/bandwidth of the DR1 WCS-WAVE tables lies within about 0.5 of it. One resolution element is λ/R.
R_BY_DETECTOR = {1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128}
# Wavelengths within half a resolution element match; up to one element they still compare, with
# a warning (spectral features can mimic a change); beyond that a difference is not meaningful.
WAVELENGTH_MATCH_FRACTION = 0.5
WAVELENGTH_LIMIT_FRACTION = 1.0
_SIP_CARD = re.compile(r"(A|B|AP|BP)_(ORDER|\d+_\d+)")
# Mask planes of the cutout's FLAGS extension whose pixels are unusable for blinking
# (bad detector pixels, saturation, cosmic rays and other per-exposure artefacts). Names
# and bit numbers come from the FLAGS header (MSKNnnnn); meanings: Table 16 of the SPHEREx
# Explanatory Supplement, https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf,
# via https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products
# Informative planes stay (SOURCE, DICHROIC, FULLSAMPLE, PHANMISS, CROSSTALK, GHOST*).
UNUSABLE_FLAGS = frozenset(
    {
        "TRANSIENT",
        "OVERFLOW",
        "SUR_ERROR",
        "NONFUNC",
        "MISSING_DATA",
        "HOT",
        "COLD",
        "NONLINEAR",
        "PERSIST",
        "OUTLIER",
        "STREAK",
        "BLOOM",
        "SNOWBALL",
        "HALO",
    }
)
# A flagged pixel this close to the target (in pixels) makes the frame unreliable there.
TARGET_FLAG_RADIUS_PX = 2
# In the blink PNGs only, masked pixels take the median of their neighbours in this window, so
# the blink shows no holes. Detection and measurement keep them NaN.
FILL_RADIUS_PX = 2


class Aligned(NamedTuple):
    """An exposure or an epoch stack on the target grid; image and variance are NaN together
    where there is no usable data (outside the exposure, masked pixels).

    The variance is the archive's pixel noise: resampling makes it overstate the noise of a grid
    pixel, and it leaves out the confusion of faint stars, so scale it to the measured scatter.
    """

    image: np.ndarray  # MJy/sr, sky level removed
    variance: np.ndarray  # (MJy/sr)², from the cutouts' VARIANCE planes
    covered: np.ndarray  # bool: inside the footprint of at least one exposure


def cutout_url(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    return f"{access_url}?center={ra:.6f},{dec:.6f}&size={size_deg * ROTATION_MARGIN:.4f}"


def fetch_cutout(client: httpx.Client, url: str, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{hashlib.sha256(url.encode()).hexdigest()[:24]}.fits"
    if path.exists():
        return path
    partial = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.part")
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                with partial.open("wb") as file:
                    for chunk in response.iter_bytes():
                        file.write(chunk)
            break
        except httpx.HTTPError as exc:
            if attempt == DOWNLOAD_ATTEMPTS or not _retryable(exc):
                partial.unlink(missing_ok=True)
                raise
            time.sleep(RETRY_BASE_S * 2 ** (attempt - 1) + random.uniform(0, 1))
    partial.replace(path)
    return path


def _retryable(exc: httpx.HTTPError) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _RETRY_STATUS
    return isinstance(exc, httpx.TransportError)


def failure_reason(exc: httpx.HTTPError, timeout_s: float) -> str:
    """Why the archive did not deliver a cutout (its answer or a timeout) and if it was retried."""
    tries = f"after {DOWNLOAD_ATTEMPTS} attempts" if _retryable(exc) else "not retried"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code} {exc.response.reason_phrase}, {tries}"
    if isinstance(exc, httpx.TimeoutException):
        return f"no answer within {timeout_s:g} s, {tries}"
    return f"{type(exc).__name__}, {tries}"


def unusable_bits(flags_header: fits.Header) -> int:
    """Bitmask of the UNUSABLE_FLAGS planes, read from the header's mask-plane names."""
    bits = 0
    for key, name in flags_header.items():
        if key.startswith("MSKN") and name in UNUSABLE_FLAGS:
            bits |= int(flags_header[f"MSKM{key[4:]}"])
    return bits


def read_image(path: Path) -> tuple[np.ndarray, np.ndarray, WCS, np.ndarray]:
    """Image and variance with unusable pixels set to NaN, their WCS and the mask of those."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as hdul:
            hdu = hdul["IMAGE"]
            data = hdu.data.astype(np.float64)
            variance = hdul["VARIANCE"].data.astype(np.float64)
            unusable = np.zeros(data.shape, dtype=bool)
            if "FLAGS" in hdul:
                flags = hdul["FLAGS"]
                unusable = (flags.data & unusable_bits(flags.header)) != 0
            data[unusable] = np.nan
            variance[unusable] = np.nan
            return data, variance, WCS(hdu.header), unusable


def for_display(frame: Aligned) -> np.ndarray:
    """The frame as the blink shows it: masked pixels inside the footprint are filled."""
    image = frame.image.copy()
    fill_with_local_median(image, frame.covered & np.isnan(image))
    return image


def fill_with_local_median(
    data: np.ndarray, unusable: np.ndarray, radius_px: int = FILL_RADIUS_PX
) -> None:
    """Replace unusable pixels in place by the median of their usable neighbours.

    A pixel whose whole neighbourhood is unusable stays NaN and renders black.
    """
    rows, cols = np.nonzero(unusable)
    if rows.size == 0:
        return
    padded = np.pad(np.where(unusable, np.nan, data), radius_px, constant_values=np.nan)
    size = 2 * radius_px + 1
    windows = np.lib.stride_tricks.sliding_window_view(padded, (size, size))[rows, cols]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        data[rows, cols] = np.nanmedian(windows.reshape(len(rows), -1), axis=1)


def target_is_flagged(
    unusable: np.ndarray, wcs: WCS, ra: float, dec: float, radius_px: int = TARGET_FLAG_RADIUS_PX
) -> bool:
    """True when an unusable pixel lies within radius_px of the target in this exposure."""
    x, y = wcs.all_world2pix([[ra, dec]], 0)[0]
    if not (np.isfinite(x) and np.isfinite(y)):
        return False
    rows = slice(max(int(np.floor(y - radius_px)), 0), max(int(np.ceil(y + radius_px)) + 1, 0))
    cols = slice(max(int(np.floor(x - radius_px)), 0), max(int(np.ceil(x + radius_px)) + 1, 0))
    return bool(unusable[rows, cols].any())


def wavelength_at(path: Path, ra: float, dec: float) -> tuple[float, float] | tuple[None, None]:
    """Wavelength and bandwidth (µm) seen at the target, from the cutout's WCS-WAVE lookup table.

    SPHEREx filters vary across the detector, so every visit sees the target at its own wavelength.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as hdul:
            header = hdul["IMAGE"].header
            if "WCS-WAVE" not in hdul or header.get("CTYPE1W") != "WAVE-TAB":
                return None, None
            x, y = WCS(header).world_to_pixel_values(ra, dec)
            # The table is indexed by raw detector pixels: the sky distortion (SIP) must not apply.
            spectral = header.copy()
            for key in [key for key in spectral if _SIP_CARD.fullmatch(key)]:
                del spectral[key]
            wavelength, bandwidth = WCS(spectral, fobj=hdul, key="W").pixel_to_world_values(x, y)
    if not (np.isfinite(wavelength) and np.isfinite(bandwidth)):
        return None, None
    return float(wavelength), float(bandwidth)


def delta_lambda_pct(a_um: float, b_um: float) -> float:
    """Wavelength difference between two frames in percent of their mean wavelength."""
    return 200 * abs(a_um - b_um) / (a_um + b_um)


def comparable_wavelengths(
    a_um: float, b_um: float, detector: int, fraction: float = WAVELENGTH_LIMIT_FRACTION
) -> bool:
    """|Δλ|/λ ≤ fraction/R; by default: frames compare only within one resolution element."""
    return delta_lambda_pct(a_um, b_um) <= 100 * fraction / R_BY_DETECTOR[detector]


def target_grid(
    ra: float, dec: float, size_deg: float, pixel_scale_arcsec: float = SPHEREX_PIXEL_SCALE_ARCSEC
) -> tuple[WCS, tuple[int, int]]:
    """Common grid for all frames: centred on the target, north up, east left."""
    size_px = max(16, round(size_deg * 3600 / pixel_scale_arcsec))
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(size_px + 1) / 2, (size_px + 1) / 2]
    scale = pixel_scale_arcsec / 3600
    wcs.wcs.cdelt = [-scale, scale]
    return wcs, (size_px, size_px)


def align(
    data: np.ndarray, variance: np.ndarray, wcs: WCS, target: WCS, shape: tuple[int, int]
) -> Aligned:
    """Resample image and variance onto the target grid and remove the sky level.

    Both are interpolated bilinearly, so an unusable (NaN) pixel blanks every grid pixel it enters.
    The sky level is the sigma-clipped median: stars do not lift it.
    """
    # One call: reproject maps the three planes with one coordinate transform.
    planes = np.stack([data, variance, np.zeros(data.shape)])
    resampled, footprint = reproject_interp((planes, wcs), target, shape_out=shape)
    image, variance, footprint = resampled[0], resampled[1], footprint[2]
    usable = np.isfinite(image) & (variance > 0)
    image[~usable] = np.nan
    variance[~usable] = np.nan
    if usable.any():
        image -= sigma_clipped_stats(image[usable], sigma=3.0, maxiters=5)[1]
    return Aligned(image, variance, footprint > 0)


def render_png(images: list[np.ndarray], directory: Path, prefix: str = "") -> list[str]:
    """One shared stretch for all frames, so brightness stays comparable while blinking."""
    lo, hi = np.nanpercentile(np.stack(images), [1.0, 99.5])
    span = hi - lo if hi > lo else 1.0
    names = []
    for index, image in enumerate(images):
        normalized = np.clip((image - lo) / span, 0, 1)
        stretched = np.arcsinh(10 * normalized) / np.arcsinh(10)
        pixels = np.nan_to_num(stretched * 255, nan=0).astype(np.uint8)
        name = f"{prefix}frame_{index:02d}.png"
        Image.fromarray(np.flipud(pixels)).save(directory / name)
        names.append(name)
    return names


DIFF_GREY = np.array([128, 128, 128], dtype=np.float64)
DIFF_EARLIER = np.array([214, 64, 48], dtype=np.float64)  # red: brighter in the earlier epoch
DIFF_LATER = np.array([52, 112, 219], dtype=np.float64)  # blue: brighter in the later epoch
DIFF_NO_DATA = np.array([40, 40, 40], dtype=np.uint8)


def render_diff(earlier: np.ndarray, later: np.ndarray, directory: Path, name: str) -> None:
    """Later minus earlier on a diverging scale, symmetric around grey at the 99th percentile."""
    diff = later - earlier
    covered = ~np.isnan(diff)
    limit = float(np.percentile(np.abs(diff[covered]), 99)) if covered.any() else 0.0
    v = np.clip(np.nan_to_num(diff) / (limit or 1.0), -1, 1)[..., None]
    rgb = DIFF_GREY + np.abs(v) * (np.where(v < 0, DIFF_EARLIER, DIFF_LATER) - DIFF_GREY)
    pixels = np.rint(rgb).astype(np.uint8)
    pixels[~covered] = DIFF_NO_DATA
    Image.fromarray(np.flipud(pixels)).save(directory / name)
