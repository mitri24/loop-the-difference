"""SPHEREx spectral model: bands and the per-pixel LVF wavelength lookup (WCS-WAVE).

SPHEREx has 6 detector arrays (D1-D6). Each is covered by a linear variable filter,
so the wavelength seen by a pixel depends on its position on the detector. Each
Level-2 image carries a ``WCS-WAVE`` binary table (FITS Paper III ``-TAB`` lookup):
control points ``X`` (9) and ``Y`` (14) in 1-based raw detector pixels and ``VALUES``
of shape (14, 9, 2) = (y, x, [wavelength_um, bandwidth_um]).

The tables are calibration products that only change with a new calibration version.
We keep one JSON copy per detector in ``app/data/wcs_wave/`` (created by
``scripts/fetch_wcs_wave.py``) so wavelengths can be *estimated* before download.
The authoritative wavelength is always recomputed from the downloaded cutout.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import cached_property, lru_cache
from pathlib import Path

import numpy as np
from scipy.interpolate import RegularGridInterpolator

WCS_WAVE_DIR = Path(__file__).resolve().parent / "data" / "wcs_wave"


@dataclass(frozen=True)
class BandInfo:
    name: str
    detector: int
    lam_min_um: float
    lam_max_um: float
    resolving_power: float
    array: str  # "SWIR" (D1-D3) or "MWIR" (D4-D6)


# Nominal values (SPHEREx Explanatory Supplement); exact per-image ranges come from IRSA.
# R as IRSA lists it for the spectral images (band N = DN), as in backend/app/frames.py:
# https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products
BANDS: dict[str, BandInfo] = {
    "D1": BandInfo("D1", 1, 0.75, 1.09, 39, "SWIR"),
    "D2": BandInfo("D2", 2, 1.10, 1.62, 41, "SWIR"),
    "D3": BandInfo("D3", 3, 1.63, 2.42, 41, "SWIR"),
    "D4": BandInfo("D4", 4, 2.42, 3.82, 35, "MWIR"),
    "D5": BandInfo("D5", 5, 3.83, 4.42, 112, "MWIR"),
    "D6": BandInfo("D6", 6, 4.42, 5.00, 128, "MWIR"),
}


@dataclass(frozen=True, eq=False)
class WaveTable:
    detector: int
    x: np.ndarray  # 1-based raw detector columns
    y: np.ndarray  # 1-based raw detector rows
    wavelength: np.ndarray  # (ny, nx) micron
    bandwidth: np.ndarray  # (ny, nx) micron
    source: str

    def __call__(self, x0: float, y0: float) -> tuple[float, float]:
        """Wavelength and bandwidth (micron) at 0-based raw detector pixel (x0, y0)."""
        px = float(np.clip(x0 + 1.0, self.x[0], self.x[-1]))
        py = float(np.clip(y0 + 1.0, self.y[0], self.y[-1]))
        lam, bw = self._interpolator((py, px))
        return float(lam), float(bw)

    @cached_property
    def _interpolator(self) -> RegularGridInterpolator:
        values = np.stack([self.wavelength, self.bandwidth], axis=-1)
        return RegularGridInterpolator((self.y, self.x), values, method="linear")


def wave_table_from_hdu(detector: int, data: np.ndarray, source: str) -> WaveTable:
    """Build a WaveTable from a ``WCS-WAVE`` FITS_rec row."""
    x = np.asarray(data["X"][0], dtype=float).ravel()
    y = np.asarray(data["Y"][0], dtype=float).ravel()
    values = np.asarray(data["VALUES"][0], dtype=float).reshape(len(y), len(x), 2)
    return WaveTable(detector, x, y, values[..., 0], values[..., 1], source)


def save_wave_table(t: WaveTable, provenance: dict[str, str]) -> Path:
    WCS_WAVE_DIR.mkdir(parents=True, exist_ok=True)
    path = WCS_WAVE_DIR / f"D{t.detector}.json"
    path.write_text(
        json.dumps(
            {
                "detector": t.detector,
                "x": t.x.tolist(),
                "y": t.y.tolist(),
                "wavelength_um": t.wavelength.tolist(),
                "bandwidth_um": t.bandwidth.tolist(),
                "calibration_source": t.source,
                "provenance": provenance,
            },
            indent=1,
        )
    )
    load_wave_table.cache_clear()
    return path


@lru_cache(maxsize=8)
def load_wave_table(detector: int) -> WaveTable | None:
    path = WCS_WAVE_DIR / f"D{detector}.json"
    if not path.exists():
        return None
    d = json.loads(path.read_text())
    return WaveTable(
        detector=d["detector"],
        x=np.asarray(d["x"], dtype=float),
        y=np.asarray(d["y"], dtype=float),
        wavelength=np.asarray(d["wavelength_um"], dtype=float),
        bandwidth=np.asarray(d["bandwidth_um"], dtype=float),
        source=d.get("calibration_source", "unknown"),
    )


def resolution_element_um(lam_um: float, band: str) -> float:
    return lam_um / BANDS[band].resolving_power


def wavelengths_match(lam_a: float, lam_b: float, band: str, fraction: float) -> bool:
    """True when two wavelengths differ by at most ``fraction`` of λ/R."""
    if not (math.isfinite(lam_a) and math.isfinite(lam_b)):
        return False
    ref = 0.5 * (lam_a + lam_b)
    return abs(lam_a - lam_b) <= fraction * resolution_element_um(ref, band)
