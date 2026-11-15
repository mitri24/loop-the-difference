"""Tests added after the science-reviewer pass (2026-11-14): release merging, release
visibility, MCP comparison safety. All offline (MockTransport / synthetic frames)."""

import json
import time

import httpx
import pytest

from app import analysis, imaging, irsa, mcp_server, releases
from app.config import settings

from .conftest import star_field
from .test_pipeline_offline import STARS, _stored

FIELDS = [
    ("s_ra", "double"),
    ("s_dec", "double"),
    ("energy_bandpassname", "char"),
    ("dataproduct_type", "char"),
    ("s_region", "char"),
    ("t_min", "double"),
    ("obs_publisher_did", "char"),
    ("obs_id", "char"),
    ("obs_collection", "char"),
    ("t_exptime", "double"),
    ("access_url", "char"),
    ("em_min", "double"),
    ("em_max", "double"),
    ("em_res_power", "double"),
    ("obs_release_date", "char"),
]
ARRAYSIZE = ' arraysize="*"'
QUAD = "POLYGON ICRS 9.5 -0.5 10.5 -0.5 10.5 0.5 9.5 0.5"


def votable(rows: list[dict], overflow: bool = False) -> str:
    head = "".join(
        f'<FIELD name="{n}" datatype="{t}"{ARRAYSIZE if t == "char" else ""}/>' for n, t in FIELDS
    )
    body = "".join("<TR>" + "".join(f"<TD>{r[n]}</TD>" for n, _ in FIELDS) + "</TR>" for r in rows)
    status = "OVERFLOW" if overflow else "OK"
    return (
        '<?xml version="1.0"?><VOTABLE version="1.3" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">'
        f'<RESOURCE type="results"><INFO name="QUERY_STATUS" value="{status}"/><TABLE>{head}'
        f"<DATA><TABLEDATA>{body}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>"
    )


def row(obs_id: str, collection: str, t_min: float) -> dict:
    return {
        "s_ra": 10.0,
        "s_dec": 0.0,
        "energy_bandpassname": "SPHEREx-D2",
        "dataproduct_type": "image",
        "s_region": QUAD,
        "t_min": t_min,
        "obs_publisher_did": f"ivo://irsa/{collection}?{obs_id}",
        "obs_id": obs_id,
        "obs_collection": collection,
        "t_exptime": 100.0,
        "access_url": f"https://irsa.example/{collection}/{obs_id}.fits",
        "em_min": 1.1e-6,
        "em_max": 1.62e-6,
        "em_res_power": 41.0,
        "obs_release_date": "2026-11-01",
    }


@pytest.mark.asyncio
async def test_same_exposure_in_two_releases_is_counted_once(monkeypatch):
    monkeypatch.setattr(settings, "collections", "auto")
    monkeypatch.setattr(
        releases,
        "_STATE",
        releases.ReleaseState(
            collections=["spherex_dr2", "spherex_qr4"],
            checked_at=time.time(),
            source="IRSA (auto-discovered)",
        ),
    )
    answers = {
        # Same physical exposure (same start time), renamed by reprocessing:
        "spherex_dr2": votable([row("DR2_A", "spherex_dr2", 61000.0)]),
        "spherex_qr4": votable(
            [row("QR4_A", "spherex_qr4", 61000.0), row("QR4_B", "spherex_qr4", 61200.0)],
            overflow=True,
        ),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=answers[request.url.params["COLLECTION"]])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        obs, _visits, checks, _ = await irsa.find_observations(10.0, 0.0, 0.1, client)
    assert [o.obs_id for o in obs] == ["DR2_A", "QR4_B"]  # DR preferred, duplicate gone
    codes = {c.code: c for c in checks}
    assert codes["duplicates_dropped"].title.startswith("1 duplicate")
    assert codes["archive_overflow"].severity == "warn"
    assert codes["releases"].severity == "ok"


@pytest.mark.asyncio
async def test_pinned_collections_with_failed_discovery_warn(monkeypatch):
    monkeypatch.setattr(settings, "collections", "spherex_qr3")
    monkeypatch.setattr(releases, "_STATE", releases.ReleaseState())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        state = await releases.get_state(client, force=True)
        check = await irsa._releases_check(client)
    assert state.collections == ["spherex_qr3"]
    assert state.error and check.severity == "warn"


def _put_pair(kind: str, lam_b: float) -> tuple[str, str]:
    grid = imaging.make_grid(10.0, 10.0, 6.0)
    a = _stored(
        star_field(grid, [*STARS, (30, 30, 4.0)], seed=11),
        grid,
        id=f"{kind}a".ljust(20, "0"),
        mjd=60900.0,
        kind="single",
        lambda_um=1.20,
    )
    b = _stored(
        star_field(grid, STARS, seed=12),
        grid,
        id=f"{kind}b".ljust(20, "0"),
        mjd=61270.0,
        kind="single",
        lambda_um=lam_b,
        visit=1,
    )
    analysis.FRAMES.put(a.meta.id, a)
    analysis.FRAMES.put(b.meta.id, b)
    return a.meta.id, b.meta.id


@pytest.mark.asyncio
async def test_mcp_compare_refuses_then_flags_forced(monkeypatch):
    async def none(*args, **kw):
        return []

    monkeypatch.setattr(analysis, "gaia_cone", none)
    monkeypatch.setattr(analysis, "allwise_cone", none)
    fa, fb = _put_pair("c", lam_b=1.60)  # Δλ ≫ λ/R → not comparable

    refused = json.loads(
        (await mcp_server.mcp.call_tool("compare_frames", {"frame_a": fa, "frame_b": fb}))
        .content[0]
        .text
    )
    assert refused["comparable"] is False and refused["images"] is None
    assert any(c["code"] == "wavelength_mismatch" for c in refused["checks"])

    forced = json.loads(
        (
            await mcp_server.mcp.call_tool(
                "compare_frames", {"frame_a": fa, "frame_b": fb, "force": True}
            )
        )
        .content[0]
        .text
    )
    codes = [c["code"] for c in forced["checks"]]
    assert "forced" in codes and "wavelength_mismatch" in codes
    assert forced["residuals"] == []  # never vetted when not comparable
