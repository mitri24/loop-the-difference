"""Automatic discovery of SPHEREx releases, on recorded real IRSA answers (no network)."""

import re
import time
from pathlib import Path

import httpx
import pytest

from app import releases
from app.config import settings

DATA = Path(__file__).parent / "data"
OPTIONS = re.findall(r'value="([^"]+)"', (DATA / "irsa_sia_collection_options.txt").read_text())


def test_select_collections_on_real_sia_options():
    assert releases.select_collections(OPTIONS, include_deep=True) == [
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr3",
        "spherex_qr3_deep",
    ]
    assert releases.select_collections(OPTIONS, include_deep=False) == [
        "spherex_dr1",
        "spherex_qr3",
    ]


def test_future_releases_are_picked_up_and_ordered():
    future = [*OPTIONS, "spherex_qr4", "spherex_dr2", "spherex_dr2_cube", "spherex_qr4_deep"]
    assert releases.select_collections(future, include_deep=True) == [
        "spherex_dr2",
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr4",
        "spherex_qr4_deep",
        "spherex_qr3",
        "spherex_qr3_deep",
    ]


def test_describe():
    assert releases.describe("spherex_qr3_deep")["label"] == "Quick Release 3 — deep fields"
    assert releases.describe("spherex_dr1") == {
        "name": "spherex_dr1",
        "label": "Data Release 1",
        "kind": "dr",
        "number": 1,
        "deep": False,
    }


def test_parse_hips_list_keeps_only_spherex():
    hips = releases.parse_hips_list((DATA / "irsa_hips_list_sample.txt").read_text())
    assert len(hips) == 1
    assert hips[0]["url"].endswith("/SPHEREx/spherex_allsky_cube")
    assert hips[0]["cube"] is True


def _client(sia_options, hips_text="", fail=False):
    def handler(request: httpx.Request) -> httpx.Response:
        if fail:
            return httpx.Response(503)
        if request.url.path == "/SIA":
            body = "".join(f'<OPTION value="{o}"/>' for o in sia_options)
            return httpx.Response(200, text=f"<VOTABLE>{body}</VOTABLE>")
        return httpx.Response(200, text=hips_text)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_get_state_discovers_new_release(monkeypatch):
    monkeypatch.setattr(releases, "_STATE", releases.ReleaseState())
    monkeypatch.setattr(settings, "collections", "auto")
    async with _client(
        [*OPTIONS, "spherex_qr4"], (DATA / "irsa_hips_list_sample.txt").read_text()
    ) as c:
        state = await releases.get_state(c, force=True)
    assert "spherex_qr4" in state.collections
    assert state.source.startswith("IRSA")
    assert state.hips[0]["cube"]


@pytest.mark.asyncio
async def test_get_state_keeps_last_known_on_failure_and_retries_soon(monkeypatch):
    monkeypatch.setattr(releases, "_STATE", releases.ReleaseState())
    monkeypatch.setattr(settings, "collections", "auto")
    async with _client([], fail=True) as c:
        state = await releases.get_state(c, force=True)
    assert state.collections == releases.FALLBACK_COLLECTIONS
    assert state.error
    # Next automatic retry is due in ~5 minutes, not in 6 hours.
    due_in = state.checked_at + settings.release_refresh_s - time.time()
    assert 0 < due_in <= releases.RETRY_AFTER_FAILURE_S + 1


@pytest.mark.asyncio
async def test_pinned_collections_are_respected(monkeypatch):
    monkeypatch.setattr(releases, "_STATE", releases.ReleaseState())
    monkeypatch.setattr(settings, "collections", "spherex_qr3")
    async with _client([*OPTIONS, "spherex_dr2"]) as c:
        state = await releases.get_state(c, force=True)
    assert state.collections == ["spherex_qr3"]
