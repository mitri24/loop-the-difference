"""Download, cache and load SPHEREx Level-2 cutouts from the IRSA cutout service.

The IRSA cutout service returns IMAGE, FLAGS, VARIANCE, ZODI, EPSF and WCS-WAVE
extensions. EPSF is a ~4 MB PSF grid for the whole detector, so every cutout costs
~4 MB on the wire. Before caching we replace it by the ePSF at the cutout centre (HDU
PSF, 8.6 kB; app/psf.py), and keep everything needed for alignment, photometry, flags,
wavelength and PSF matching (~0.3 MB for the default 8' field).

Cache layout: ``<cache_dir>/cutouts/<sha1>.fits`` keyed by (access_url, centre, size).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from .config import settings
from .psf import EPSF, epsf_at
from .spectral import WaveTable, wave_table_from_hdu

log = logging.getLogger(__name__)

KEEP_EXTENSIONS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")
# Cached cutouts written before version 2 have no PSF HDU: they are downloaded again.
CACHE_VERSION = 2

# Flag planes (names come from the FLAGS header, MSKNnnnn). Classified once here.
# HARD: the pixel value is not usable -> masked (NaN) everywhere.
HARD_FLAGS = {"SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD"}
# DEGRADED: value kept but less reliable. SPHEREx fits the up-the-ramp slope with the
# samples taken before overflow, so saturated stars still have finite, increasing
# values (verified on real cutouts, see QUALITY.md). Shown, flagged, never hidden.
DEGRADED_FLAGS = {"OVERFLOW", "NONLINEAR"}
ARTIFACT_FLAGS = {
    "TRANSIENT",
    "PERSIST",
    "OUTLIER",
    "CROSSTALK",
    "GHOST",
    "GHOST_FPA",
    "GHOST_EXT",
    "STREAK",
    "BLOOM",
    "SNOWBALL",
    "HALO",
    "DICHROIC",
    "PHANMISS",
}
INFO_FLAGS = {"SOURCE", "FULLSAMPLE"}


class CutoutError(RuntimeError):
    pass


@dataclass
class Cutout:
    """A cached cutout, ready for science."""

    path: Path
    image: np.ndarray  # MJy/sr
    flags: np.ndarray  # int32 bitmask
    variance: np.ndarray  # (MJy/sr)^2
    zodi: np.ndarray  # MJy/sr model
    wcs: WCS  # celestial TAN-SIP WCS of this cutout
    header: fits.Header  # IMAGE header (all metadata keywords)
    raw_offset: tuple[float, float]  # add to 0-based cutout pixel -> 0-based detector pixel
    wave: WaveTable
    flag_names: dict[int, str] = field(default_factory=dict)  # bit -> name
    psf: EPSF | None = None  # ePSF at the cutout centre; None if the archive sent none

    @property
    def mjd(self) -> float:
        return float(self.header.get("MJD-AVG", self.header.get("MJD-OBS")))

    @property
    def pixel_solid_angle_sr(self) -> float:
        omega_arcsec2 = float(self.header.get("OMEGA_MEDIAN", settings.native_pixel_arcsec**2))
        return omega_arcsec2 * (np.pi / 180 / 3600) ** 2

    def wavelength_at(self, x: float, y: float) -> tuple[float, float]:
        """Wavelength/bandwidth (micron) at 0-based cutout pixel (x, y)."""
        return self.wave(x + self.raw_offset[0], y + self.raw_offset[1])

    def mask(self, names: set[str]) -> np.ndarray:
        bits = 0
        for bit, name in self.flag_names.items():
            if name in names:
                bits |= 1 << bit
        return (self.flags & bits) != 0

    def flags_in(self, x: float, y: float, radius_px: float) -> list[str]:
        yy, xx = np.indices(self.flags.shape)
        sel = (xx - x) ** 2 + (yy - y) ** 2 <= radius_px**2
        combined = int(np.bitwise_or.reduce(self.flags[sel])) if sel.any() else 0
        return sorted(name for bit, name in self.flag_names.items() if combined & (1 << bit))


def cache_key(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    raw = f"{access_url}|{ra:.5f}|{dec:.5f}|{size_deg:.4f}"
    return hashlib.sha1(raw.encode()).hexdigest()


def cutout_url(access_url: str, ra: float, dec: float, size_deg: float) -> str:
    return f"{access_url}?center={ra:.6f},{dec:.6f}d&size={size_deg:.4f}"


def _raw_offset(hdr: fits.Header) -> tuple[float, float]:
    """Add to a 0-based cutout pixel to get the 0-based detector pixel.

    The 'A' WCS is LINEAR: raw0 = CRVAL + (p1 - CRPIX), p1 = cut0 + 1."""
    return (
        float(hdr.get("CRVAL1A", 0.0)) + 1.0 - float(hdr.get("CRPIX1A", 1.0)),
        float(hdr.get("CRVAL2A", 0.0)) + 1.0 - float(hdr.get("CRPIX2A", 1.0)),
    )


def _target_psf(hdul: fits.HDUList, ra: float, dec: float) -> fits.ImageHDU | None:
    """The ePSF at (ra, dec) as a small image HDU, or None without a usable EPSF table."""
    if "EPSF" not in [h.name for h in hdul]:
        return None
    hdr = hdul["IMAGE"].header
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            x, y = WCS(hdr, naxis=2).world_to_pixel_values(ra, dec)
        off_x, off_y = _raw_offset(hdr)
        model = epsf_at(hdul["EPSF"], float(x) + off_x, float(y) + off_y)
    except (KeyError, ValueError) as exc:
        log.warning("EPSF table not usable: %s", exc)
        return None
    header = fits.Header()
    header["OVSMPX"], header["OVSMPY"] = model.oversampling
    header["DETX"] = (round(float(x) + off_x, 2), "0-based detector x of this ePSF")
    header["DETY"] = (round(float(y) + off_y, 2), "0-based detector y of this ePSF")
    header["COMMENT"] = "SPHEREx ePSF at the cutout centre, bilinear between EPSF zones"
    for line in hdul["EPSF"].header.get("HISTORY", []):
        header["HISTORY"] = str(line)
    return fits.ImageHDU(model.data.astype(np.float32), header, name="PSF")


def _strip_and_save(content: bytes, path: Path, ra: float, dec: float) -> None:
    with fits.open(io.BytesIO(content)) as hdul:
        names = [h.name for h in hdul]
        missing = [e for e in ("IMAGE", "FLAGS", "VARIANCE", "WCS-WAVE") if e not in names]
        if missing:
            raise CutoutError(f"cutout lacks extensions {missing}")
        keep = fits.HDUList([fits.PrimaryHDU(header=hdul[0].header)])
        keep[0].header["CACHEVER"] = (CACHE_VERSION, "analysis-service cutout cache format")
        for ext in KEEP_EXTENSIONS:
            if ext in names:
                keep.append(hdul[ext].copy())
        if (psf_hdu := _target_psf(hdul, ra, dec)) is not None:
            keep.append(psf_hdu)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        keep.writeto(tmp, overwrite=True)
        tmp.replace(path)


async def fetch_cutout(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    access_url: str,
    ra: float,
    dec: float,
    size_deg: float,
) -> Path:
    """Return the cached path of a cutout, downloading it if needed (3 retries). One cached
    before CACHE_VERSION is fetched again for its ePSF, and kept (without) if that fails."""
    path = settings.cutout_cache / f"{cache_key(access_url, ra, dec, size_deg)}.fits"
    if _cached(path):
        return path
    url = cutout_url(access_url, ra, dec, size_deg)
    last: Exception | None = None
    async with sem:
        for attempt in range(3):
            try:
                r = await client.get(url, timeout=settings.http_timeout_s)
                r.raise_for_status()
                if not r.content.startswith(b"SIMPLE"):
                    raise CutoutError(f"not a FITS file ({r.headers.get('content-type')})")
                await asyncio.to_thread(_strip_and_save, r.content, path, ra, dec)
                return path
            except (httpx.HTTPError, CutoutError, OSError) as exc:
                last = exc
                log.warning("cutout attempt %d failed for %s: %s", attempt + 1, url, exc)
                await asyncio.sleep(1.5 * (attempt + 1))
    if path.exists():
        log.warning("keeping %s without its ePSF: %s", path.name, last)
        return path
    raise CutoutError(f"cutout download failed after 3 attempts: {last}")


def _cached(path: Path) -> bool:
    try:
        return int(fits.getheader(path, 0).get("CACHEVER", 1)) >= CACHE_VERSION
    except (OSError, ValueError):
        return False


def _flag_names(header: fits.Header) -> dict[int, str]:
    out: dict[int, str] = {}
    for key, value in header.items():
        if key.startswith("MSKN") and key[4:].isdigit():
            out[int(key[4:])] = str(value).strip()
    return out


def load_cutout(path: Path) -> Cutout:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path, memmap=False) as hdul:
            names = [h.name for h in hdul]
            hdr = hdul["IMAGE"].header
            image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
            flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
            variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float32)
            zodi = (
                np.asarray(hdul["ZODI"].data, dtype=np.float32)
                if "ZODI" in names
                else np.zeros_like(image)
            )
            target_psf = None
            if "PSF" in names:
                h = hdul["PSF"]
                oversampling = (int(h.header["OVSMPX"]), int(h.header["OVSMPY"]))
                target_psf = EPSF(np.asarray(h.data, dtype=float), oversampling)
            wcs = WCS(hdr, naxis=2)
            detector = int(hdr.get("DETECTOR", 0))
            source = "cutout WCS-WAVE"
            for h in hdul["WCS-WAVE"].header.get("HISTORY", []):
                if "Calibration source file" in str(h):
                    source = str(h).split(":", 1)[-1].strip()
            wave = wave_table_from_hdu(detector, hdul["WCS-WAVE"].data, source)
            flag_names = _flag_names(hdul["FLAGS"].header)
    return Cutout(
        path=path,
        image=image,
        flags=flags,
        variance=variance,
        zodi=zodi,
        wcs=wcs,
        header=hdr,
        raw_offset=_raw_offset(hdr),
        wave=wave,
        flag_names=flag_names,
        psf=target_psf,
    )
