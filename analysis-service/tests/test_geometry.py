import numpy as np
import pytest

from app.astrometry import angular_sep_arcsec, propagate
from app.footprint import DETECTOR_PIXELS, fov_coverage, parse_s_region, sky_to_detector
from app.spectral import BANDS, load_wave_table, wavelengths_match

from .conftest import tan_wcs


def _quad_from_wcs(w):
    n = DETECTOR_PIXELS
    corners = [(0, 0), (n, 0), (n, n), (0, n)]
    pts = [w.pixel_to_world_values(x, y) for x, y in corners]
    return "POLYGON ICRS " + " ".join(f"{float(r)} {float(d)}" for r, d in pts)


@pytest.mark.parametrize(
    ("ra", "dec", "rot"), [(10.0, 20.0, 0), (359.5, -30.0, 33), (120.0, 85.0, -70)]
)
def test_sky_to_detector_recovers_pixels(ra, dec, rot):
    w = tan_wcs(ra, dec, DETECTOR_PIXELS, 6.15, rot)
    quad = parse_s_region(_quad_from_wcs(w))
    for px, py in [(100, 100), (1020, 1500), (2000, 30)]:
        r, d = (float(v) for v in w.pixel_to_world_values(px, py))
        x, y, inside = sky_to_detector(quad, r, d)
        assert inside
        assert abs(x - px) < 1.5 and abs(y - py) < 1.5


def test_closed_polygon_and_outside():
    q = parse_s_region("POLYGON ICRS 1 1 2 1 2 2 1 2 1 1")
    assert q is not None
    assert not sky_to_detector(q, 5.0, 5.0)[2]
    assert parse_s_region("CIRCLE 1 2 3") is None


def test_fov_coverage_partial():
    w = tan_wcs(50.0, 0.0, DETECTOR_PIXELS, 6.15)
    quad = parse_s_region(_quad_from_wcs(w))
    edge_ra = float(w.pixel_to_world_values(0, 1020)[0])
    assert fov_coverage(quad, 50.0, 0.0, 0.1) == 1.0
    assert 0.3 < fov_coverage(quad, edge_ra, 0.0, 0.1) < 0.7


def test_propagate_barnard():
    ra, dec = propagate(269.4520769586187, 4.69336496657667, -801.551, 10362.394, 2000.0, 2026.0)
    assert (dec - 4.69336496657667) * 3600 == pytest.approx(10.362394 * 26, rel=1e-6)
    assert angular_sep_arcsec(269.4520769586187, 4.69336496657667, ra, dec) == pytest.approx(
        np.hypot(0.801551, 10.362394) * 26, rel=1e-3
    )


@pytest.mark.parametrize("band", list(BANDS))
def test_wave_tables_cover_band(band):
    info = BANDS[band]
    t = load_wave_table(info.detector)
    assert t is not None, "run scripts/fetch_wcs_wave.py"
    assert (
        info.lam_min_um - 0.05 <= t.wavelength.min() <= t.wavelength.max() <= info.lam_max_um + 0.05
    )
    lam, bw = t(1000, 1000)
    assert info.lam_min_um - 0.05 < lam < info.lam_max_um + 0.05 and bw > 0


def test_wavelengths_match():
    assert wavelengths_match(1.300, 1.305, "D2", 0.5)  # λ/R = 0.032 µm
    assert not wavelengths_match(1.30, 1.40, "D2", 0.5)
