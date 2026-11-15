"""Footprint geometry: from an IRSA ``s_region`` polygon to detector pixel coordinates.

IRSA's ``s_region`` for a SPHEREx spectral image is a 4-vertex polygon whose vertices
are, in order, the sky positions of detector corners (x, y) =
(0, 0) → (W, 0) → (W, H) → (0, H) in the 0-based "active pixel" frame
(verified against the full TAN-SIP WCS in ``tests/test_footprint.py``).

Inverting the bilinear map from the unit square to that quadrilateral (in a gnomonic
projection centred on the quad) gives the detector pixel where a sky position lands,
to within a few pixels (SIP distortion is ignored). That is enough to look up the
LVF wavelength at the target *before* downloading anything: the SPHEREx linear
variable filter changes wavelength by one resolution element over ~100 pixels.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

DETECTOR_PIXELS = 2040


@dataclass(frozen=True)
class Quad:
    ra: tuple[float, float, float, float]
    dec: tuple[float, float, float, float]

    @property
    def vertices(self) -> list[tuple[float, float]]:
        return list(zip(self.ra, self.dec, strict=True))


_POLY = re.compile(r"POLYGON\s+(?:ICRS\s+)?(.*)", re.IGNORECASE)


def parse_s_region(s_region: str) -> Quad | None:
    """Parse ``POLYGON ICRS ra1 dec1 ... ra4 dec4``. Returns None if not a 4-gon."""
    m = _POLY.match(s_region.strip())
    if not m:
        return None
    nums = [float(x) for x in m.group(1).split()]
    # Some releases close the ring (5th vertex == 1st): drop the duplicate.
    if len(nums) == 10 and abs(nums[8] - nums[0]) < 1e-9 and abs(nums[9] - nums[1]) < 1e-9:
        nums = nums[:8]
    if len(nums) != 8:
        return None
    return Quad(ra=tuple(nums[0::2]), dec=tuple(nums[1::2]))  # type: ignore[arg-type]


def _gnomonic(ra: np.ndarray, dec: np.ndarray, ra0: float, dec0: float) -> np.ndarray:
    """Project (deg) onto the tangent plane at (ra0, dec0). Returns (..., 2) in deg."""
    r, d = np.radians(ra), np.radians(dec)
    r0, d0 = math.radians(ra0), math.radians(dec0)
    cosc = math.sin(d0) * np.sin(d) + math.cos(d0) * np.cos(d) * np.cos(r - r0)
    x = np.cos(d) * np.sin(r - r0) / cosc
    y = (math.cos(d0) * np.sin(d) - math.sin(d0) * np.cos(d) * np.cos(r - r0)) / cosc
    return np.degrees(np.stack([x, y], axis=-1))


def _centroid(quad: Quad) -> tuple[float, float]:
    # Average unit vectors: safe across RA=0 and near the poles.
    r = np.radians(quad.ra)
    d = np.radians(quad.dec)
    v = np.stack([np.cos(d) * np.cos(r), np.cos(d) * np.sin(r), np.sin(d)]).mean(axis=1)
    v /= np.linalg.norm(v)
    return math.degrees(math.atan2(v[1], v[0])) % 360.0, math.degrees(math.asin(v[2]))


def sky_to_unit_square(
    quad: Quad, ra: float | np.ndarray, dec: float | np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Invert the bilinear quad map. Returns (u, v); inside the footprint iff both in [0,1]."""
    ra0, dec0 = _centroid(quad)
    p = _gnomonic(np.asarray(quad.ra), np.asarray(quad.dec), ra0, dec0)
    t = _gnomonic(np.atleast_1d(ra).astype(float), np.atleast_1d(dec).astype(float), ra0, dec0)
    p0, p1, p2, p3 = p
    u = np.full(t.shape[0], 0.5)
    v = np.full(t.shape[0], 0.5)
    for _ in range(20):  # Newton iterations; converges in ~4 for convex quads
        a = (1 - u)[:, None] * (1 - v)[:, None] * p0 + u[:, None] * (1 - v)[:, None] * p1
        b = u[:, None] * v[:, None] * p2 + (1 - u)[:, None] * v[:, None] * p3
        f = a + b - t
        du = (1 - v)[:, None] * (p1 - p0) + v[:, None] * (p2 - p3)
        dv = (1 - u)[:, None] * (p3 - p0) + u[:, None] * (p2 - p1)
        det = du[:, 0] * dv[:, 1] - du[:, 1] * dv[:, 0]
        det = np.where(np.abs(det) < 1e-15, 1e-15, det)
        step_u = (f[:, 0] * dv[:, 1] - f[:, 1] * dv[:, 0]) / det
        step_v = (du[:, 0] * f[:, 1] - du[:, 1] * f[:, 0]) / det
        u, v = u - step_u, v - step_v
        if np.all(np.abs(step_u) < 1e-9) and np.all(np.abs(step_v) < 1e-9):
            break
    return u, v


def sky_to_detector(quad: Quad, ra: float, dec: float) -> tuple[float, float, bool]:
    """Approximate 0-based detector pixel (x, y) of a sky position, and whether inside."""
    u, v = sky_to_unit_square(quad, ra, dec)
    x, y = float(u[0]) * DETECTOR_PIXELS, float(v[0]) * DETECTOR_PIXELS
    inside = 0.0 <= u[0] <= 1.0 and 0.0 <= v[0] <= 1.0
    return x, y, bool(inside)


def fov_coverage(quad: Quad, ra: float, dec: float, fov_deg: float, n: int = 9) -> float:
    """Fraction of a square FOV centred on (ra, dec) that falls inside the footprint."""
    half = fov_deg / 2
    offs = np.linspace(-half, half, n)
    dx, dy = np.meshgrid(offs, offs)
    cosd = max(math.cos(math.radians(dec)), 1e-6)
    ras = (ra + dx.ravel() / cosd) % 360.0
    decs = np.clip(dec + dy.ravel(), -90.0, 90.0)
    u, v = sky_to_unit_square(quad, ras, decs)
    inside = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    return float(inside.mean())
