"""MCP server: the SPHEREx Time-Domain Explorer as tools for AI agents.

Why: the web UI is for humans; agents (Claude Code, Claude Desktop, any MCP client) need
the same science through function calls. Every tool runs the SAME pipeline as the web
app (app.analysis), on real NASA SPHEREx data, and returns the same evidence checks —
so an agent can answer "did this star move between 2025 and 2026?" with provenance, and
cannot skip the comparability rules (force=true is
allowed for inspection but is flagged by a failing `forced` check).

Run (stdio):      uv run python -m app.mcp_server          (from backend/)
Registered in:    /.mcp.json  → visible in Claude Code with /mcp
Shares the cutout cache with the web app (backend/cache), so `make precache` helps both.
No web server needed: tools call the pipeline in-process (frames live in this process).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
import sys

import httpx
from mcp.server.mcpserver import Context, Image, MCPServer

from . import analysis, irsa, releases
from .astrometry import mjd_to_jyear
from .catalogs import ResolveError, resolve_name
from .config import settings
from .schemas import Check, SequenceRequest, Target
from .spectral import BANDS
from .targets import find_demo
from .validation import parse_dec, parse_fov, parse_ra

# stdio transport: stdout carries the protocol, so logs must go to stderr.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

mcp = MCPServer(
    name="spherex",
    title="SPHEREx Time-Domain Explorer",
    instructions=(
        "Tools to find, align, blink and compare real NASA SPHEREx infrared images of any sky "
        "position. Typical flow: resolve_target → find_observations → build_blink → "
        "compare_frames (→ check_known_asteroids). Always report the `checks` returned: they "
        "say whether images are comparable. A residual is a candidate to verify, never a "
        "discovery. Cite NASA SPHEREx / IRSA and the source URLs."
    ),
)

_PENDING: set[asyncio.Future] = set()  # keep progress notifications alive until sent
_COORDS = re.compile(r"^\s*(\S+)[\s,]+(\S+)\s*$")
_NUM_OR_SEXA = re.compile(r"^[+-]?[\d:.hmsd°'″\"]+$")


async def _target(target: str) -> Target:
    """'Barnard's Star' (name, with proper motion) or 'RA Dec' (decimal or sexagesimal)."""
    m = _COORDS.match(target)
    if m and all(_NUM_OR_SEXA.match(g) for g in m.groups()) and any(c.isdigit() for c in target):
        try:
            return Target(
                name=None,
                ra=parse_ra(m.group(1)),
                dec=parse_dec(m.group(2)),
                source="coordinates (no proper motion)",
            )
        except ValueError:
            pass  # e.g. "M 31": fall through to the name resolver
    async with httpx.AsyncClient() as client:
        try:
            return await resolve_name(target, client)
        except (ResolveError, httpx.HTTPError):
            demo = find_demo(target)
            if demo is None:
                raise
            return demo


def _checks(checks: list[Check]) -> list[dict]:
    return [
        {"code": c.code, "severity": c.severity, "title": c.title, "detail": c.detail}
        for c in checks
    ]


@mcp.tool()
async def list_releases(refresh: bool = False) -> dict:
    """SPHEREx data releases currently used (auto-discovered at NASA/IPAC IRSA).

    Set refresh=true to re-check IRSA now for new releases (e.g. a new quick release)."""
    state = await releases.get_state(force=refresh)
    return {
        "collections": [releases.describe(c) for c in state.collections],
        "source": state.source,
        "error": state.error,
        "sky_maps": [h["url"] for h in state.hips],
    }


@mcp.tool()
async def resolve_target(target: str) -> dict:
    """Resolve an object name (SIMBAD via CDS Sesame) or parse 'RA Dec' coordinates.

    Returns the ICRS position (deg) at `epoch_jyear` and proper motion (mas/yr) when known."""
    return (await _target(target)).model_dump()


@mcp.tool()
async def find_observations(target: str, fov_arcmin: float = 6.0) -> dict:
    """Every SPHEREx exposure covering a target: counts per band, visits (≈ every 6
    months), date range, and archive checks. Does not download images (fast, ~5 s)."""
    t = await _target(target)
    fov = parse_fov(fov_arcmin)
    ra, dec = analysis.target_at(t, analysis.SEARCH_EPOCH_JYEAR)
    # irsa.find_observations: the archive search (this tool has the same name).
    obs, visits, checks, urls = await irsa.find_observations(ra, dec, fov / 60)
    per_band = {b: sum(1 for o in obs if o.band == b) for b in BANDS}
    return {
        "target": t.model_dump(),
        "position_now": {"ra": ra, "dec": dec, "epoch_jyear": analysis.SEARCH_EPOCH_JYEAR},
        "n_exposures": len(obs),
        "per_band": per_band,
        "visits": [v.model_dump() for v in visits],
        "first": obs[0].date_utc if obs else None,
        "latest": obs[-1].date_utc if obs else None,
        "collections": sorted({o.collection for o in obs}),
        "checks": _checks(checks + irsa.search_checks(obs, visits)),
        "archive_queries": urls,
    }


@mcp.tool()
async def build_blink(
    target: str,
    band: str = "D2",
    mode: str = "stack",
    fov_arcmin: float = 6.0,
    ctx: Context | None = None,
) -> dict:
    """Download, align and stack SPHEREx images of a target into a blink sequence.

    band: D1..D6 (0.75–5 µm). mode: 'stack' (one deep image per visit — best for motion),
    'matched' (same wavelength per visit — best for brightness), 'all' (every exposure).
    First run on a new target downloads ~4 MB per exposure (20–90 s); cached afterwards.
    Returns frame ids (for get_frame_image / compare_frames), dates, wavelengths, flags,
    the expected motion of the target and the evidence checks."""
    t = await _target(target)
    req = SequenceRequest(
        ra=t.ra,
        dec=t.dec,
        name=t.name,
        pm_ra_mas_yr=t.pm_ra_mas_yr,
        pm_dec_mas_yr=t.pm_dec_mas_yr,
        target_epoch_jyear=t.epoch_jyear,
        band=band,
        fov_arcmin=fov_arcmin,
        mode=mode,  # type: ignore[arg-type]
    )

    def progress(p: float, msg: str) -> None:
        # The pipeline reports progress synchronously; forward it to the MCP client as a
        # fire-and-forget notification (clients show it while downloads run).
        if ctx is None:
            return
        pending = ctx.report_progress(p, 1.0, msg)
        if inspect.isawaitable(pending):
            task = asyncio.ensure_future(pending)
            _PENDING.add(task)
            task.add_done_callback(_PENDING.discard)

    res = await analysis.run_sequence(req, progress)
    return {
        "band": res.band,
        "mode": res.mode,
        "grid": {
            "ra": res.grid.ra,
            "dec": res.grid.dec,
            "fov_arcmin": res.grid.fov_arcmin,
            "pixel_arcsec": res.grid.pixel_arcsec,
        },
        "frames": [
            {
                "id": f.id,
                "visit": f.visit_label,
                "date_utc": f.date_utc,
                "lambda_um": round(f.lambda_um, 4),
                "n_exposures": f.n_exposures,
                "flags_at_target": f.flags_at_target,
                "coverage": round(f.coverage, 3),
                "collections": f.collections,
                "source_urls": f.source_urls,
            }
            for f in res.frames
        ],
        "checks": _checks(res.checks),
        "failed_downloads": len(res.failed),
    }


@mcp.tool()
async def get_frame_image(frame_id: str) -> Image:
    """PNG of an aligned frame or of a difference (north up, east left, native 6.15″ pixels).

    frame_id: an id from build_blink, or a difference id from compare_frames
    (append '_sig' for the significance map)."""
    if not re.fullmatch(r"[0-9a-f]{20}(_sig)?", frame_id):
        raise ValueError("Unknown frame id format.")
    path = settings.frame_cache / f"{frame_id}.png"
    if not path.exists():
        raise ValueError("Frame not found: build the sequence (or difference) first.")
    return Image(path=path)


@mcp.tool()
async def compare_frames(frame_a: str, frame_b: str, force: bool = False) -> dict:
    """Difference image A − B with comparability checks and automatically classified
    residuals (candidates).

    If the frames are not comparable (band or wavelength mismatch) the difference is
    refused unless force=true (inspection only). Each residual has a `kind`:
    moving_star, bright_star, known_source, red_source, solar_system or unknown
    ("needs verification" — never call it a discovery)."""
    res = await analysis.difference(frame_a, frame_b, force)
    return {
        "difference_id": res.id,
        "comparable": res.comparable,
        "delta_days": round(res.delta_days, 2),
        "delta_lambda_nm": round(res.delta_lambda_um * 1000, 1),
        "checks": _checks(res.checks),
        "residuals": [
            {
                "kind": r.kind,
                "significance": round(r.significance, 1),
                "ra": r.ra,
                "dec": r.dec,
                "explanation": r.explanation,
            }
            for r in res.residuals
        ],
        "images": {"difference": res.id, "significance": f"{res.id}_sig"} if res.png_url else None,
    }


@mcp.tool()
async def check_known_asteroids(difference_id: str) -> dict:
    """Ask NASA/JPL SBIdent which known asteroids/comets were in the field at both epochs
    of a difference, and re-explain its residuals. Slow: 1–3 minutes."""
    res = await analysis.run_solar_system_check(difference_id, lambda p, m: None)
    return {
        "known_objects": [m.model_dump() for m in res.solar_system or []],
        "residuals": [{"kind": r.kind, "explanation": r.explanation} for r in res.residuals],
        "comparable": res.comparable,
        # ALL checks: comparability warnings still apply to the re-explained residuals.
        "checks": _checks(res.checks),
    }


@mcp.tool()
async def measure_spectrum(target: str, max_exposures: int = 60) -> dict:
    """Aperture photometry of the target in every SPHEREx exposure (each one sees it at a
    different wavelength): a 0.75–5 µm spectrum per visit. Downloads up to
    `max_exposures` small cutouts (~4 MB each the first time)."""
    t = await _target(target)
    res = await analysis.run_spectrum(t, max(10, min(max_exposures, 400)), lambda p, m: None)
    return {
        "aperture_arcsec": res.aperture_arcsec,
        "points": [
            {
                "lambda_um": round(p.lambda_um, 4),
                "band": p.band,
                "visit": p.visit,
                "epoch_jyear": round(mjd_to_jyear(p.mjd), 3),
                "flux_mjy": round(p.flux_mjy, 3),
                "err_mjy": round(p.flux_err_mjy, 3),
                "quality": p.quality,
            }
            for p in res.points
        ],
        "checks": _checks(res.checks),
    }


def main() -> None:
    mcp.run("stdio")


if __name__ == "__main__":
    main()
