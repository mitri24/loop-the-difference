"""Science pipeline on synthetic data (no network)."""

from pathlib import Path

import httpx
import numpy as np
import pytest

from app import analysis, catalogs, imaging
from app.schemas import Check, Observation, SolarSystemObject, Target

from .conftest import make_frame, star_field


def _stored(img, grid, var=1e-4, **meta):
    return analysis.StoredFrame(
        meta=make_frame(**meta),
        image=img,
        variance=np.full_like(img, var),
        hard_mask=np.zeros(img.shape, bool),
        flags=np.zeros(img.shape, np.int64),
        grid=grid,
        target=Target(ra=grid.ra, dec=grid.dec),
        flag_names={},
    )


STARS = [
    (10, 12, 5.0),
    (40, 8, 3.0),
    (25, 30, 8.0),
    (50, 50, 2.0),
    (8, 45, 4.0),
    (33, 52, 6.0),
    (52, 20, 3.5),
    (18, 24, 2.5),
]


async def no_wise(*args, **kw):
    return [], []


def test_registration_recovers_known_shift():
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _stored(star_field(grid, STARS, seed=1), grid)
    b = _stored(star_field(grid, STARS, seed=2, shift=(0.30, -0.20)), grid, mjd=61200.0)
    dx, dy, _, n = analysis.measure_offset(a, b)
    assert n >= 5
    assert dx == pytest.approx(0.30, abs=0.06) and dy == pytest.approx(-0.20, abs=0.06)
    b2, check, _ = analysis.register(a, b)
    dx2, dy2, _, _ = analysis.measure_offset(a, b2)
    assert abs(dx2) < 0.08 and abs(dy2) < 0.08
    assert check.code == "registration"


def test_photometric_scale():
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    img = star_field(grid, STARS, seed=3, noise=0.001)
    a = _stored(img, grid, var=1e-6)
    b = _stored(img / 1.25, grid, var=1e-6)
    scale, n = analysis.photometric_scale(a, b)
    assert n >= 20 and scale == pytest.approx(1.25, rel=0.02)


@pytest.mark.asyncio
async def test_difference_finds_a_mover_and_blocks_mismatch(monkeypatch):
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    static = STARS
    a_img = star_field(grid, [*static, (30, 30, 4.0)], seed=4)
    b_img = star_field(grid, [*static, (33, 30, 4.0)], seed=5)
    a = _stored(a_img, grid, id="a" * 20, mjd=60900.0, kind="stack")
    b = _stored(b_img, grid, id="b" * 20, mjd=61270.0, kind="stack", visit=1)
    analysis.FRAMES.put(a.meta.id, a)
    analysis.FRAMES.put(b.meta.id, b)

    async def no_sources(*args, **kw):
        return []

    monkeypatch.setattr(analysis, "gaia_cone", no_sources)
    monkeypatch.setattr(analysis, "wise_cone", no_wise)
    res = await analysis.difference(a.meta.id, b.meta.id, force=False)
    assert res.comparable
    pos = [r for r in res.residuals if r.significance > 0]
    neg = [r for r in res.residuals if r.significance < 0]
    assert pos and neg, "a mover leaves a +/- pair"
    assert any(abs(r.x - 30) <= 1 for r in pos) and any(abs(r.x - 33) <= 1 for r in neg)
    assert all(r.known_source is None for r in res.residuals)

    c = _stored(b_img, grid, id="c" * 20, mjd=61270.0, kind="single", lambda_um=1.6, visit=1)
    a2 = _stored(a_img, grid, id="d" * 20, mjd=60900.0, kind="single", lambda_um=1.2)
    analysis.FRAMES.put(c.meta.id, c)
    analysis.FRAMES.put(a2.meta.id, a2)
    blocked = await analysis.difference(a2.meta.id, c.meta.id, force=False)
    assert not blocked.comparable and blocked.png_url == ""


def _obs(visit, lam, mjd):
    return Observation(
        obs_publisher_did=f"d{visit}{lam}",
        obs_id=f"o{visit}{lam}",
        collection="spherex_dr1",
        band="D2",
        detector=2,
        mjd=mjd,
        date_utc="x",
        exptime_s=100,
        access_url="u",
        s_region="",
        em_min_um=1.1,
        em_max_um=1.6,
        resolving_power=41,
        lambda_est_um=lam,
        visit=visit,
    )


def test_choose_matched_picks_wavelength_present_in_most_visits():
    obs = [
        _obs(0, 1.20, 1),
        _obs(0, 1.40, 2),
        _obs(1, 1.401, 200),
        _obs(2, 1.399, 400),
        _obs(2, 1.25, 401),
    ]
    lam, sel = analysis.choose_matched(obs, "D2", None)
    assert lam == pytest.approx(1.40, abs=0.002)
    assert [o.visit for o in sel] == [0, 1, 2]


def test_render_png_is_png_and_marks_no_data():
    img = np.zeros((9, 9))
    img[0, 0] = np.nan
    png = imaging.render_png(img, -1, 1)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert imaging.render_png(img, -1, 1, diverging=True)[:4] == b"\x89PNG"


@pytest.mark.asyncio
async def test_failed_catalogue_degrades_with_warning(monkeypatch):
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _stored(star_field(grid, [*STARS, (30, 30, 4.0)], seed=6), grid, id="e" * 20, kind="stack")
    b = _stored(
        star_field(grid, STARS, seed=7), grid, id="g" * 20, mjd=61270.0, kind="stack", visit=1
    )
    analysis.FRAMES.put(a.meta.id, a)
    analysis.FRAMES.put(b.meta.id, b)

    async def boom(*args, **kw):
        raise analysis.httpx.ConnectError("down")

    async def none(*args, **kw):
        return []

    monkeypatch.setattr(analysis, "gaia_cone", boom)
    monkeypatch.setattr(analysis, "wise_cone", no_wise)
    res = await analysis.difference(a.meta.id, b.meta.id, force=False)
    assert any(c.code == "gaia_unavailable" and c.severity == "warn" for c in res.checks)
    assert res.residuals and res.residuals[0].kind == "unknown"
    assert "asteroid/comet check" in res.residuals[0].explanation


@pytest.mark.asyncio
async def test_catwise_sources_without_gaia_are_moving_or_red_at_the_frame_epoch():
    """Recorded CatWISE2020 rows around WISE 0855−0714 (8″/yr, no Gaia counterpart)."""
    votable = (Path(__file__).parent / "data" / "catwise_wise0855_sample.xml").read_bytes()
    catalogs._CATALOG_CACHE.clear()
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=votable))
    async with httpx.AsyncClient(transport=transport) as client:
        wise = await catalogs.catwise_cone(133.786, -7.2453, 0.01, client)
    grid = imaging.make_grid(133.762, -7.242, 4.0)
    a = _stored(np.zeros((grid.npix, grid.npix)), grid, mjd=60800.0)
    b = _stored(np.zeros((grid.npix, grid.npix)), grid, mjd=61164.0)
    # J085507.96−071439.3 moved to frame A's epoch, and a source without significant motion.
    mover = grid.wcs.world_to_pixel_values(133.76189, -7.24153)
    still = grid.wcs.world_to_pixel_values(133.7894629, -7.2508305)
    peaks = [(float(mover[0]), float(mover[1]), 9.0), (float(still[0]), float(still[1]), -7.0)]
    refs = analysis.References(gaia=[], wise=wise, sso_a=None, sso_b=None)

    moving, red = analysis._vet_residuals(peaks, a, b, refs)

    assert moving.kind == "moving_star" and moving.known_source.startswith("CatWISE2020 J08550")
    assert "expected to move 1.3 px between the frames" in moving.explanation
    assert red.kind == "red_source" and red.known_source == "CatWISE2020 J085509.47-071502.9"
    assert "CatWISE2020 sees move less than half a pixel" in red.explanation


@pytest.mark.asyncio
async def test_the_wise_fallback_and_failure_reach_the_difference_checks(monkeypatch):
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    fallback = Check(code="catwise_unavailable", severity="warn", title="t", detail="d")

    async def none(*args, **kw):
        return []

    async def allwise_only(*args, **kw):
        return [], [fallback]

    async def down(*args, **kw):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(analysis, "gaia_cone", none)
    monkeypatch.setattr(analysis, "wise_cone", allwise_only)
    refs, checks = await analysis._fetch_static_references(grid)
    assert checks == [fallback] and refs.wise == []

    monkeypatch.setattr(analysis, "wise_cone", down)
    refs, checks = await analysis._fetch_static_references(grid)
    assert [(c.code, c.severity) for c in checks] == [("wise_unavailable", "warn")]
    assert "ConnectError" in checks[0].detail and refs.wise == []


@pytest.mark.asyncio
async def test_solar_system_check_explains_residual(monkeypatch):
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _stored(star_field(grid, [*STARS, (30, 30, 4.0)], seed=8), grid, id="h" * 20, kind="stack")
    b = _stored(
        star_field(grid, STARS, seed=9), grid, id="i" * 20, mjd=61270.0, kind="stack", visit=1
    )
    analysis.FRAMES.put(a.meta.id, a)
    analysis.FRAMES.put(b.meta.id, b)

    async def none(*args, **kw):
        return []

    monkeypatch.setattr(analysis, "gaia_cone", none)
    monkeypatch.setattr(analysis, "wise_cone", no_wise)
    res = await analysis.difference(a.meta.id, b.meta.id, force=False)
    ra, dec = (float(v) for v in grid.wcs.pixel_to_world_values(30, 30))

    async def fake_sbident(ra0, dec0, half, mjd, client):
        if abs(mjd - 60900.0) < 1:
            eros = SolarSystemObject(
                name="(433) Eros",
                ra=ra,
                dec=dec,
                vmag=14.0,
                ra_rate_arcsec_h=30.0,
                mjd=mjd,
                observer="SPHEREx",
            )
            return "SPHEREx", [eros]
        return "geocentre", []

    monkeypatch.setattr(analysis, "sbident_field", fake_sbident)
    updated = await analysis.run_solar_system_check(res.id, lambda p, m: None)
    top = next(r for r in updated.residuals if r.significance > 0)
    assert top.kind == "solar_system" and top.known_source == "(433) Eros"
    assert "(JPL SBIdent, seen from SPHEREx)" in top.explanation
    assert updated.solar_system and updated.solar_system[0].epoch == "A"
    detail = next(c.detail for c in updated.checks if c.code == "solar_system")
    assert detail.startswith("JPL Small-Body Identification API, A seen from SPHEREx (its position")
    assert "; B seen from the geocentre, as JPL Horizons gave no SPHEREx position" in detail


def test_sso_match_uses_track_and_magnitude_limit():
    from .conftest import make_frame

    stack = make_frame(mjd=61000.0, mjd_start=60998.0, mjd_end=61002.0, kind="stack")
    # Object 30"/h eastward: over ±48 h it sweeps ±1440". A residual 600" east of the
    # mean position, on the track, matches; one 600" north (off-track) does not.
    o = SolarSystemObject(name="A", ra=10.0, dec=0.0, vmag=18.0, ra_rate_arcsec_h=30.0, mjd=61000.0)
    hit, sep = analysis._match_sso([o], 10.0 + 600 / 3600, 0.0, stack, 6.15)
    assert hit is o and sep < 1
    miss, _ = analysis._match_sso([o], 10.0, 600 / 3600, stack, 6.15)
    assert miss is None
    faint = o.model_copy(update={"vmag": 23.8})
    assert analysis._match_sso([faint], 10.0, 0.0, stack, 6.15)[0] is None
