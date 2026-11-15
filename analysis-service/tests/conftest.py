"""Shared fixtures. Tests marked `network` hit real IRSA/CDS/ESA services."""

from __future__ import annotations

import numpy as np
import pytest
from astropy.wcs import WCS

from app import imaging
from app.schemas import Frame


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch, request):
    """Never write into the real cache from unit tests, and never hit IRSA for release
    discovery in offline tests (network tests keep the real discovery)."""
    import time

    from app import releases
    from app.config import settings

    monkeypatch.setattr(settings, "cache_dir", tmp_path / "cache")
    if "network" not in request.keywords:
        monkeypatch.setattr(
            releases,
            "_STATE",
            releases.ReleaseState(checked_at=time.time(), source="test fixture"),
        )


def make_frame(**over) -> Frame:
    base = dict(
        id="f" * 20,
        kind="single",
        band="D2",
        visit=0,
        visit_label="V1 2025-08",
        mjd=60900.0,
        date_utc="2025-08-26T00:00:00Z",
        lambda_um=1.30,
        lambda_min_um=1.30,
        lambda_max_um=1.30,
        bandwidth_um=0.03,
        n_exposures=1,
        obs_ids=["x"],
        source_urls=["https://irsa.ipac.caltech.edu/x.fits"],
        collections=["spherex_dr1"],
        flags_at_target=[],
        hard_flag_fraction=0.0,
        coverage=1.0,
        psf_fwhm_arcsec=7.0,
        background_mjy_sr=0.1,
        noise_mjy_sr=0.05,
        png_url="/p.png",
        fits_url="/p.fits",
        target_px=(10.0, 10.0),
    )
    base.update(over)
    base.setdefault("mjd_start", base["mjd"])
    base.setdefault("mjd_end", base["mjd"])
    return Frame(**base)


def star_field(grid: imaging.Grid, stars, fwhm_px=1.2, noise=0.01, seed=0, shift=(0.0, 0.0)):
    """Synthetic Gaussian stars on the grid. `stars` = [(x, y, amplitude)]."""
    rng = np.random.default_rng(seed)
    yy, xx = np.indices((grid.npix, grid.npix), dtype=float)
    img = rng.normal(0, noise, (grid.npix, grid.npix))
    s = fwhm_px / 2.3548
    for x, y, amp in stars:
        img += amp * np.exp(-((xx - x - shift[0]) ** 2 + (yy - y - shift[1]) ** 2) / (2 * s * s))
    return img


def tan_wcs(ra: float, dec: float, npix: int, scale_arcsec: float, rot_deg: float = 0.0) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(npix + 1) / 2, (npix + 1) / 2]
    s = scale_arcsec / 3600
    th = np.radians(rot_deg)
    w.wcs.cd = np.array([[-s * np.cos(th), s * np.sin(th)], [s * np.sin(th), s * np.cos(th)]])
    return w
