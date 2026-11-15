"""MCP server: tool catalogue and behaviour in-process (offline), plus a real stdio
round-trip like Claude Code does (network: `pytest -m network`)."""

import json
import sys
from pathlib import Path

import pytest

from app import mcp_server

EXPECTED_TOOLS = {
    "list_releases",
    "resolve_target",
    "find_observations",
    "build_blink",
    "get_frame_image",
    "compare_frames",
    "check_known_asteroids",
    "measure_spectrum",
}


@pytest.mark.asyncio
async def test_tool_catalogue_is_documented():
    tools = await mcp_server.mcp.list_tools()
    assert {t.name for t in tools} == EXPECTED_TOOLS
    for t in tools:
        assert t.description and len(t.description) > 40, t.name  # agents read these


@pytest.mark.asyncio
async def test_list_releases_uses_discovered_state():
    result = await mcp_server.mcp.call_tool("list_releases", {})
    payload = json.loads(result.content[0].text)
    assert payload["collections"][0]["name"].startswith("spherex_")


@pytest.mark.asyncio
async def test_coordinates_are_parsed_without_network():
    t = await mcp_server._target("08:55:10.83 -07:14:42.5")
    assert t.ra == pytest.approx(133.79513, abs=1e-4)
    assert t.dec == pytest.approx(-7.245139, abs=1e-4)
    assert t.pm_ra_mas_yr is None


@pytest.mark.asyncio
async def test_get_frame_image_rejects_bad_ids():
    # In-process the SDK raises; over the protocol the client receives isError=true.
    with pytest.raises(Exception, match="get_frame_image") as exc:
        await mcp_server.mcp.call_tool("get_frame_image", {"frame_id": "../../etc/passwd"})
    assert "Unknown frame id format" in str(exc.value.__cause__)


@pytest.mark.network
@pytest.mark.asyncio
async def test_stdio_round_trip_like_claude_code():
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(
        command=sys.executable, args=["-m", "app.mcp_server"], cwd=Path(__file__).parents[1]
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        names = {t.name for t in (await session.list_tools()).tools}
        assert names == EXPECTED_TOOLS
        res = await session.call_tool("find_observations", {"target": "Barnard's Star"})
        payload = json.loads(res.content[0].text)
        assert payload["n_exposures"] > 100 and len(payload["visits"]) >= 2
