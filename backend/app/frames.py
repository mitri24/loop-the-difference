import hashlib
import os
import random
import re
import threading
import time
import warnings
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
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
# Spectral resolving power per detector (SPHEREx instrument design): one resolution element is λ/R.
R_BY_DETECTOR = {1: 41, 2: 41, 3: 41, 4: 35, 5: 110, 6: 130}
_SIP_CARD = re.compile(r"(A|B|AP|BP)_(ORDER|\d+_\d+)")


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


def read_image(path: Path) -> tuple[np.ndarray, WCS]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as hdul:
            hdu = hdul["IMAGE"]
            return hdu.data.astype(np.float64), WCS(hdu.header)


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


def comparable_wavelengths(a_um: float, b_um: float, detector: int) -> bool:
    """Frames compare directly only within one resolution element: |Δλ|/λ ≤ 1/R."""
    return delta_lambda_pct(a_um, b_um) <= 100 / R_BY_DETECTOR[detector]


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
    data: np.ndarray, wcs: WCS, target: WCS, shape: tuple[int, int]
) -> tuple[np.ndarray, float]:
    """Resample onto the target grid and remove the background level; returns image and coverage."""
    aligned, footprint = reproject_interp((data, wcs), target, shape_out=shape)
    covered = footprint > 0
    coverage = float(covered.mean())
    aligned[~covered] = np.nan
    if coverage > 0:
        aligned -= np.nanmedian(aligned)
    return aligned, coverage


def render_png(images: list[np.ndarray], directory: Path) -> list[str]:
    """One shared stretch for all frames, so brightness stays comparable while blinking."""
    lo, hi = np.nanpercentile(np.stack(images), [1.0, 99.5])
    span = hi - lo if hi > lo else 1.0
    names = []
    for index, image in enumerate(images):
        normalized = np.clip((image - lo) / span, 0, 1)
        stretched = np.arcsinh(10 * normalized) / np.arcsinh(10)
        pixels = np.nan_to_num(stretched * 255, nan=0).astype(np.uint8)
        name = f"frame_{index:02d}.png"
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
