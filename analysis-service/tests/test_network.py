"""End-to-end checks against the real archives. Run: uv run pytest -m network"""

import httpx
import pytest

from app import analysis
from app.cutouts import fetch_cutout, load_cutout
from app.irsa import find_observations
from app.schemas import SequenceRequest
from app.spectral import resolution_element_um

pytestmark = [pytest.mark.network, pytest.mark.asyncio]

BARNARD_2026 = (269.4486, 4.7394)


async def test_barnard_has_multiple_visits_in_configured_releases():
    obs, visits, checks, _ = await find_observations(*BARNARD_2026, 6 / 60)
    assert len(obs) > 100
    assert len(visits) >= 2
    assert not [c for c in checks if c.code == "archive_error"]


async def test_wavelength_estimate_matches_cutout():
    import asyncio

    obs, *_ = await find_observations(*BARNARD_2026, 6 / 60)
    sample = obs[:: max(1, len(obs) // 4)][:4]
    async with httpx.AsyncClient(follow_redirects=True) as c:
        sem = asyncio.Semaphore(4)
        for o in sample:
            cut = load_cutout(await fetch_cutout(c, sem, o.access_url, *BARNARD_2026, 0.03))
            x, y = cut.wcs.world_to_pixel_values(*BARNARD_2026)
            lam, _ = cut.wavelength_at(float(x), float(y))
            assert abs(lam - o.lambda_est_um) < 0.2 * resolution_element_um(lam, o.band)


async def test_barnard_sequence_end_to_end():
    req = SequenceRequest(
        ra=269.4520769586187,
        dec=4.69336496657667,
        pm_ra_mas_yr=-801.551,
        pm_dec_mas_yr=10362.394,
        band="D2",
        fov_arcmin=4,
        mode="stack",
    )
    res = await analysis.run_sequence(req, lambda p, m: None)
    assert len(res.frames) >= 2
    shift = next(c for c in res.checks if c.code == "target_motion")
    assert "px" in shift.title
    diff = await analysis.difference(res.frames[0].id, res.frames[-1].id, force=False)
    assert diff.comparable


async def test_release_discovery_against_irsa():
    from app import releases

    state = await releases.get_state(force=True)
    assert state.source.startswith("IRSA"), state.error
    assert "spherex_dr1" in state.collections
    assert any(h["cube"] for h in state.hips)


async def test_cadc_lists_neossat_images_of_barnard():
    from app import catalogs

    catalogs._CADC_CACHE.clear()
    async with httpx.AsyncClient(follow_redirects=True) as c:
        res = await catalogs.cadc_images(*BARNARD_2026, 4 / 60, c)
        assert not [k for k in res.checks if k.code == "cadc_unavailable"]
        neo = next(g for g in res.collections if g.collection == "NEOSSAT")
        assert neo.n_images > 100  # 632 on 2026-11-13
        thumb = await c.get(neo.images[0].thumbnail_url, timeout=60)
        assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/png"
