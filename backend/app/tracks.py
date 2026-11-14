"""Where a distant Solar System object would appear at other times, for assumed distances.

Not an orbit: two marks of one epoch fix the direction and the sky motion; the distance is an
explicit assumption. Over SPHEREx's half-year epoch gap Earth's own motion (parallax) dominates.
"""

import numpy as np
from astropy import units as u
from astropy.coordinates import get_body_barycentric
from astropy.time import Time
from fastapi import APIRouter

from app.coords import parse_dec, parse_ra
from app.models import DistanceHypothesis, DistantTrack, DistantTrackRequest, TrackPoint

MODEL = "straight-line heliocentric motion + Earth parallax"
ASSUMPTIONS = [
    "Each hypothesis is one assumed distance from Earth at the first mark, not an orbit.",
    "No motion along the line of sight at the first mark.",
    "Straight-line motion plus the Sun's pull at the first mark, held constant.",
    "Positions as seen from Earth's centre; light travel time is ignored.",
    "Search radius = 2σ from the mark uncertainties only; the model error grows with time.",
]

# Gaussian gravitational constant: k² = GM_sun in AU³/day².
K = 0.01720209895
ARCSEC_PER_RAD = 206264.80624709636
_Z = np.array([0.0, 0.0, 1.0])

router = APIRouter()


@router.post("/api/track/distant")
def distant_track(request: DistantTrackRequest) -> DistantTrack:
    first, second = request.marks
    marks = np.array(
        [[parse_ra(m.ra), parse_dec(m.dec), m.mjd, m.sigma_arcsec] for m in (first, second)]
    )
    distances = 1 / np.linspace(1 / request.d_min_au, 1 / request.d_max_au, request.steps)
    targets = np.array(request.target_mjds)
    ra, dec, radius = predict(marks, distances, targets)
    hypotheses = [
        DistanceHypothesis(
            distance_au=float(d),
            points=[
                TrackPoint(mjd=float(t), ra=float(r), dec=float(de), radius_arcsec=float(rad))
                for t, r, de, rad in zip(targets, ra[i], dec[i], radius[i], strict=True)
            ],
        )
        for i, d in enumerate(distances)
    ]
    return DistantTrack(model=MODEL, assumptions=ASSUMPTIONS, hypotheses=hypotheses)


def predict(
    marks: np.ndarray, distances: np.ndarray, targets: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """marks: 2 × (ra°, dec°, mjd, σ″). Returns ra°, dec°, 2σ radius″, each distances × targets."""
    (ra1, dec1, t1, s1), (ra2, dec2, t2, s2) = marks
    times = Time(np.concatenate([[t1, t2], targets]), format="mjd", scale="utc")
    earth = get_body_barycentric("earth", times).xyz.to_value(u.au).T
    sun = get_body_barycentric("sun", times[0]).xyz.to_value(u.au)

    # Row 0 is the marks as given; rows 1–4 move one mark coordinate by its σ.
    sky1 = np.tile([ra1, dec1], (5, 1))
    sky2 = np.tile([ra2, dec2], (5, 1))
    sky1[1, 0] += s1 / 3600 / np.cos(np.radians(dec1))
    sky1[2, 1] += s1 / 3600
    sky2[3, 0] += s2 / 3600 / np.cos(np.radians(dec2))
    sky2[4, 1] += s2 / 3600
    directions = _positions(
        _unit(*sky1.T), _unit(*sky2.T), distances, t2 - t1, targets - t1, earth, sun
    )

    base = directions[0]
    east = _normalize(np.cross(_Z, base))
    north = np.cross(base, east)
    shift = directions[1:] - base
    dx = np.sum(shift * east, axis=-1) * ARCSEC_PER_RAD
    dy = np.sum(shift * north, axis=-1) * ARCSEC_PER_RAD
    cxx, cyy, cxy = np.sum(dx * dx, axis=0), np.sum(dy * dy, axis=0), np.sum(dx * dy, axis=0)
    largest = (cxx + cyy) / 2 + np.sqrt(((cxx - cyy) / 2) ** 2 + cxy**2)

    ra = np.degrees(np.arctan2(base[..., 1], base[..., 0])) % 360
    dec = np.degrees(np.arcsin(np.clip(base[..., 2], -1, 1)))
    return ra, dec, 2 * np.sqrt(largest)


def _positions(u1, u2, distances, dt, tau, earth, sun):
    """Unit directions from Earth, shape variants × distances × targets × 3."""
    u1, u2 = u1[:, None, :], u2[:, None, :]
    p1 = earth[0] + distances[None, :, None] * u1
    r = p1 - sun
    g = -(K**2) * r / np.linalg.norm(r, axis=-1, keepdims=True) ** 3
    a1 = _normalize(np.cross(u1, _Z))
    a2 = np.cross(u1, a1)
    # Velocity across the line of sight (x·a1 + y·a2) that brings the object onto mark 2.
    matrix = np.stack(np.broadcast_arrays(a1 * dt, a2 * dt, -u2), axis=-1)
    rhs = earth[1] - p1 - 0.5 * g * dt**2
    x, y, _ = np.moveaxis(np.linalg.solve(matrix, rhs[..., None])[..., 0], -1, 0)
    velocity = x[..., None] * a1 + y[..., None] * a2
    tau = tau[:, None]
    position = (
        p1[:, :, None, :]
        + velocity[:, :, None, :] * tau
        + 0.5 * g[:, :, None, :] * tau**2
        - earth[2:]
    )
    return _normalize(position)


def _unit(ra, dec):
    ra, dec = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)


def _normalize(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)
