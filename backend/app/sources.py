"""Every point source in the blink frames, labelled by the catalogue that knows a source there.

A label is a positional coincidence within the match radius (wider for very bright stars), not an
identification: "none"
means neither Gaia DR3 nor AllWISE lists a source there, so it needs verification.
"""

import csv
import hashlib
import io
import json
import os
import threading
import time
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import httpx
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.stats import gaussian_fwhm_to_sigma, sigma_clipped_stats
from astropy.table import Table
from astropy.wcs import WCS
from photutils.detection import find_peaks
from photutils.psf import fit_2dgaussian
from scipy import ndimage

from app.catalogs import GAIA_TAP_URL, position_at
from app.frames import ROTATION_MARGIN, SPHEREX_PIXEL_SCALE_ARCSEC, Aligned
from app.models import Check, DetectedSource, ProperMotion

# PSF width on the aligned grid, measured: the EPSF extension of a detector-6 cutout is 6.5-7.1
# samples wide at 5x oversampling (1.3-1.4 detector pixels); resampling onto the grid widens it
# to 1.62-1.66 px (Gaussian fits to 9 stars in two aligned WISE 0855 frames).
FWHM_PX = 1.6
# That PSF over 5×5 pixels (DAOFIND's kernel size at this FWHM), peak 1.
_R2 = np.add.outer(np.arange(-2, 3) ** 2, np.arange(-2, 3) ** 2)
PSF = np.exp(-_R2 / (2 * (FWHM_PX * gaussian_fwhm_to_sigma) ** 2))
# Local sky for detection: the median of the usable pixels in a square this wide (about seven PSF
# widths) around every pixel. Gradients, halos and nebulae change more slowly than a star.
SKY_BOX_PX = 11
# Grid rows whose sky is sorted at once: a whole 1° grid would take 0.6 GB.
SKY_ROWS = 32
# The grid edge cuts sources this close to it: no centre.
EDGE_PX = 2
THRESHOLD_SIGMA = 5.0
# Highest peaks per frame; keeps the manifest small in crowded fields.
MAX_SOURCES = 300
# 39 of 41 Gaia DR3 matches in two real WISE 0855 frames lie within 3.0″ (one at 5.1″, S/N 5);
# 1 px keeps them while halving chance alignments against 1.5 px.
MATCH_RADIUS_PX = 1.0
MATCH_RADIUS_ARCSEC = MATCH_RADIUS_PX * SPHEREX_PIXEL_SCALE_ARCSEC
# A very bright star saturates: a masked core too large for a PSF fit is placed by its rim (see
# detect), which put Barnard's Star 2.6″ (median, at most 7.9″) from Gaia DR3 in 281 real D1-D3
# exposures. So stars brighter than these magnitudes claim detections up to 3 px away.
# Brightness, not S/N: an S/N rule would let faint neighbours absorb bright movers.
BRIGHT_MAG = {"gaia": 10.0, "allwise": 8.0}
BRIGHT_RADIUS_PX = 3.0
BRIGHT_RADIUS_ARCSEC = BRIGHT_RADIUS_PX * SPHEREX_PIXEL_SCALE_ARCSEC
CATALOG_TIMEOUT_S = 10.0
# Rows per catalogue and field (Gaia DR3: brightest, AllWISE: nearest); a crowded field is cut.
MAX_CATALOG_ROWS = 10000
ALLWISE_TABLE = "allwise_p3as_psd"
# IRSA's catalogue query API: 2-3 s per field, while IRSA TAP took minutes or answered 502.
GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"


class Detection(NamedTuple):
    x: float  # numpy column
    y: float  # numpy row (row 0 is south: the PNG is flipped)
    peak: float
    snr: float
    saturated: bool = False  # placed by the rim of its masked core, see _saturated


class CatalogStar(NamedTuple):
    catalog_id: str
    ra: float
    dec: float
    mag: float | None
    # Gaia DR3 only: the star is moved to each frame's date.
    motion: ProperMotion | None = None


def detect(frame: Aligned, fit: np.ndarray | None = None) -> tuple[list[Detection], bool]:
    """Point sources at least THRESHOLD_SIGMA above the noise, highest peak first; True if capped.

    The local sky goes first. Then at every pixel the PSF is fitted to the usable pixels around
    it, weighted by the inverse variance: peak is the fitted height, snr its significance. Masked
    pixels never enter, so a masked core moves no centroid. The VARIANCE planes leave out
    resampling and faint unresolved stars, so the S/N map is scaled to unit scatter (a median
    absolute deviation, which sources barely move), as SExtractor scales weight maps.

    With `fit`, a boolean mask of the grid, only the peaks on its pixels get a centroid fit (the
    others keep their peak pixel): the injection test (app/completeness.py) needs positions only
    where it set stars, and the fits take nearly all the time. Which sources are found is the same.
    """
    usable = np.isfinite(frame.image)
    if not usable.any():
        return [], False
    local = frame._replace(image=frame.image - _local_sky(frame))
    weight = np.where(usable, 1 / frame.variance, 0.0)
    fitted = ndimage.correlate(np.where(usable, local.image, 0.0) * weight, PSF, mode="constant")
    norm = ndimage.correlate(weight, PSF**2, mode="constant")
    with np.errstate(divide="ignore", invalid="ignore"):
        peak, snr = fitted / norm, fitted / np.sqrt(norm)
    scale = sigma_clipped_stats(snr[norm > 0], sigma=3.0, stdfunc="mad_std")[2]
    if not scale > 0:
        return [], False
    snr /= scale
    # A gap the PSF cannot bridge (sky outside the exposure, a saturated core) and the grid edge
    # leave the sources they cut without a centre, and a gap's rim would give spurious peaks.
    gaps, _ = ndimage.label(~usable)
    large = (gaps > 0) & (np.bincount(gaps.ravel())[gaps] >= PSF.size)
    near_gap = ndimage.binary_dilation(large, structure=np.ones(PSF.shape, dtype=bool))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # "no peaks found" is an answer, not a problem
        table = find_peaks(snr, THRESHOLD_SIGMA, box_size=len(PSF), border_width=EDGE_PX)
    peaks = [] if table is None else list(zip(table["x_peak"], table["y_peak"], strict=True))
    peaks = sorted((p for p in peaks if not near_gap[p[1], p[0]]), key=lambda p: -peak[p[1], p[0]])
    # A saturated core is placed by its rim's own light: the local sky would take the halo's share.
    saturated = _saturated(frame, gaps, large, snr)
    found = saturated + _centroids(local, peaks[:MAX_SOURCES], peak, snr, fit)
    found.sort(key=lambda d: d.peak, reverse=True)
    return found[:MAX_SOURCES], len(saturated) + len(peaks) > MAX_SOURCES


def _local_sky(frame: Aligned) -> np.ndarray:
    """Median of the usable pixels in the SKY_BOX_PX square around every pixel, 0 where none."""
    padded = np.pad(frame.image, SKY_BOX_PX // 2, constant_values=np.nan)
    windows = np.lib.stride_tricks.sliding_window_view(padded, (SKY_BOX_PX, SKY_BOX_PX))
    sky = np.zeros(frame.image.shape)
    for start in range(0, len(sky), SKY_ROWS):
        block = windows[start : start + SKY_ROWS]
        ordered = np.sort(block.reshape(*block.shape[:2], -1), axis=-1)  # NaN sorts last
        count = np.isfinite(ordered).sum(axis=-1, keepdims=True)
        low = np.take_along_axis(ordered, np.maximum(count - 1, 0) // 2, axis=-1)
        high = np.take_along_axis(ordered, count // 2, axis=-1)
        sky[start : start + SKY_ROWS] = np.where(count > 0, (low + high) / 2, 0.0)[..., 0]
    return sky


def _centroids(
    frame: Aligned,
    peaks: list[tuple[int, int]],
    peak: np.ndarray,
    snr: np.ndarray,
    fit: np.ndarray | None = None,
) -> list[Detection]:
    """Sub-pixel positions from a PSF fit to the usable pixels around each S/N peak (each peak on
    its own, so fitting fewer moves none); with `fit` only for the peaks on its pixels."""
    fitted = [p for p in peaks if fit is None or fit[p[1], p[0]]]
    places = {}
    if fitted:
        usable = np.isfinite(frame.image)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # a fit that does not converge keeps its peak pixel
            result = fit_2dgaussian(
                frame.image,
                xypos=fitted,
                fwhm=FWHM_PX,
                fit_shape=len(PSF),
                error=np.sqrt(np.where(usable, frame.variance, 1.0)),
            ).results
        for (px, py), fx, fy in zip(fitted, result["x_fit"], result["y_fit"], strict=True):
            places[px, py] = (fx, fy) if max(abs(fx - px), abs(fy - py)) <= 1 else (px, py)
    found = []
    for px, py in peaks:
        x, y = places.get((px, py), (px, py))
        found.append(Detection(float(x), float(y), float(peak[py, px]), float(snr[py, px])))
    return found


def _saturated(
    frame: Aligned, gaps: np.ndarray, large: np.ndarray, snr: np.ndarray
) -> list[Detection]:
    """A masked core too large for a PSF fit, inside the footprint, at least EDGE_PX from the grid
    edge and ringed by significant pixels, is a saturated star: placed at the flux-weighted centre
    of its 2-px rim. Nearer the edge only part of the rim is left, which would pull it 15-25″.

    Its peak is the brightest usable rim pixel, a lower limit; its snr the rim's median.
    """
    inner = np.zeros(gaps.shape, dtype=bool)
    inner[EDGE_PX:-EDGE_PX, EDGE_PX:-EDGE_PX] = True
    found = []
    for label in np.unique(gaps[large]):
        core = gaps == label
        rim = ndimage.binary_dilation(core, iterations=2) & np.isfinite(frame.image)
        if not (inner[core].all() and frame.covered[core].all() and rim.any()):
            continue
        significance = float(np.median(snr[rim]))
        if significance < THRESHOLD_SIGMA:
            continue
        flux = np.clip(frame.image[rim], 0.0, None)
        rows, cols = np.nonzero(rim)
        x, y = np.average(cols, weights=flux), np.average(rows, weights=flux)
        peak = float(frame.image[rim].max())
        found.append(Detection(float(x), float(y), peak, significance, saturated=True))
    return found


def gaia_stars(content: str) -> list[CatalogStar]:
    """Gaia DR3 CSV rows (see query_gaia); a star without proper motion keeps its 2016.0 place."""
    stars = []
    for row in csv.DictReader(io.StringIO(content)):
        try:
            motion = ProperMotion(
                source_id=row["source_id"],
                ra=float(row["ra"]),
                dec=float(row["dec"]),
                ref_epoch=float(row["ref_epoch"]),
                pmra_mas_yr=float(row["pmra"] or 0),
                pmdec_mas_yr=float(row["pmdec"] or 0),
                parallax_mas=None,
            )
        except (KeyError, TypeError, ValueError):
            continue
        mag = row.get("phot_g_mean_mag")
        stars.append(
            CatalogStar(
                f"Gaia DR3 {motion.source_id}",
                motion.ra,
                motion.dec,
                float(mag) if mag else None,
                motion,
            )
        )
    return stars


def allwise_stars(table: Table) -> list[CatalogStar]:
    """AllWISE rows (see query_allwise); positions are for about 2010."""
    stars = []
    for row in table:
        mag = row["w1mpro"]
        stars.append(
            CatalogStar(
                f"AllWISE {row['designation']}",
                float(row["ra"]),
                float(row["dec"]),
                None if np.ma.is_masked(mag) else float(mag),
            )
        )
    return stars


def query_gaia(ra: float, dec: float, radius_deg: float) -> list[CatalogStar]:
    query = (
        f"SELECT TOP {MAX_CATALOG_ROWS} source_id, ra, dec, pmra, pmdec, ref_epoch, "
        "phot_g_mean_mag FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT(ra, dec), CIRCLE({ra}, {dec}, {radius_deg})) "
        "ORDER BY phot_g_mean_mag"
    )
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}
    response = httpx.post(GAIA_TAP_URL, data=params, timeout=CATALOG_TIMEOUT_S)
    response.raise_for_status()
    return gaia_stars(response.text)


def query_allwise(ra: float, dec: float, radius_deg: float) -> list[CatalogStar]:
    params = {
        "catalog": ALLWISE_TABLE,
        "spatial": "cone",
        "objstr": f"{ra} {dec}",
        "radius": radius_deg * 3600,
        "radunits": "arcsec",
        "outfmt": 3,  # VOTable
        "selcols": "designation,ra,dec,w1mpro",
        "outrows": MAX_CATALOG_ROWS,
    }
    response = httpx.get(GATOR_URL, params=params, timeout=CATALOG_TIMEOUT_S)
    response.raise_for_status()
    return allwise_stars(Table.read(io.BytesIO(response.content), format="votable"))


Query = Callable[[float, float, float], list[CatalogStar]]


def cached_query(
    cache_dir: Path, name: str, query: Query, ra: float, dec: float, radius_deg: float
) -> list[CatalogStar]:
    """One answer per catalogue and field on disk; a failed query is not cached, so it retries."""
    key = hashlib.sha256(f"{name}|{ra:.5f}|{dec:.5f}|{radius_deg:.4f}".encode()).hexdigest()[:16]
    path = cache_dir / "catalogs" / f"{name}-{key}.json"
    if path.is_file():
        rows = json.loads(path.read_text())
        return [CatalogStar(*row[:4], ProperMotion(**row[4]) if row[4] else None) for row in rows]
    stars = query(ra, dec, radius_deg)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.part")
    partial.write_text(
        json.dumps(
            [[*star[:4], star.motion.model_dump() if star.motion else None] for star in stars]
        )
    )
    partial.replace(path)
    return stars


def field_catalogs(
    ra: float, dec: float, radius_deg: float, cache_dir: Path
) -> tuple[list[CatalogStar] | None, list[CatalogStar] | None]:
    """Gaia DR3 and AllWISE around the field, asked in parallel; None for a failed catalogue."""
    answers: dict[str, list[CatalogStar] | None] = {}

    def ask(name: str, query: Query) -> None:
        try:
            answers[name] = cached_query(cache_dir, name, query, ra, dec, radius_deg)
        # A catalogue only labels sources: a timeout, an HTTP error or a malformed answer
        # leaves them "unknown" and must never fail the frame job.
        except Exception:
            answers[name] = None

    # Daemon threads: a late answer must not keep a process alive.
    threads = [
        threading.Thread(target=ask, args=item, daemon=True)
        for item in (("gaia", query_gaia), ("allwise", query_allwise))
    ]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + CATALOG_TIMEOUT_S
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))
    return answers.get("gaia"), answers.get("allwise")


def _brightest_within(
    position: SkyCoord, stars: list[CatalogStar], places: SkyCoord, catalog: str
) -> list[tuple[CatalogStar, float] | None]:
    """Per detection the brightest catalogue source within its match radius, and its distance.

    At SPHEREx resolution the brightest source dominates a blend; a faint neighbour may lie closer.
    Stars brighter than BRIGHT_MAG[catalog] match up to BRIGHT_RADIUS_ARCSEC.
    """
    best: list[tuple[CatalogStar, float] | None] = [None] * len(position)
    near, index, separation, _ = places.search_around_sky(position, BRIGHT_RADIUS_ARCSEC * u.arcsec)
    pairs: dict[int, list[tuple[CatalogStar, float]]] = {}
    for i, j, sep in zip(near, index, separation.to_value(u.arcsec), strict=True):
        star = stars[j]
        bright = star.mag is not None and star.mag < BRIGHT_MAG[catalog]
        if sep <= MATCH_RADIUS_ARCSEC or bright:
            pairs.setdefault(int(i), []).append((star, float(sep)))
    for i, candidates in pairs.items():
        best[i] = min(candidates, key=lambda c: (c[0].mag is None, c[0].mag or 0.0, c[1]))
    return best


def label(
    detections: list[Detection],
    grid: WCS,
    shape: tuple[int, int],
    mjd: float,
    gaia: list[CatalogStar] | None,
    allwise: list[CatalogStar] | None,
) -> list[DetectedSource]:
    """Sky position of each detection and the catalogue source within the match radius.

    Very bright stars match up to BRIGHT_RADIUS_ARCSEC; see BRIGHT_MAG.

    Gaia DR3 wins over AllWISE; "none" needs both catalogues to have answered in full.
    """
    if not detections:
        return []
    xs = np.array([d.x for d in detections])
    ys = np.array([d.y for d in detections])
    ras, decs = grid.pixel_to_world_values(xs, ys)
    position = SkyCoord(ras * u.deg, decs * u.deg)
    # A cut catalogue may lack the counterpart, so a missing match is no "none" then.
    complete = all(s is not None and len(s) < MAX_CATALOG_ROWS for s in (gaia, allwise))
    hits = {}
    for name, stars in (("gaia", gaia), ("allwise", allwise)):
        if not stars:
            continue
        places = [position_at(s.motion, mjd) if s.motion else (s.ra, s.dec) for s in stars]
        hits[name] = _brightest_within(position, stars, SkyCoord(*np.array(places).T * u.deg), name)

    sources = []
    for i, d in enumerate(detections):
        match, star, separation = "none" if complete else "unknown", None, None
        for name, found in hits.items():
            if found[i]:
                match, (star, separation) = name, found[i]
                break
        sources.append(
            DetectedSource(
                ra=round(float(ras[i]) % 360, 6),
                dec=round(float(decs[i]), 6),
                x=round(d.x, 2),
                y=round(shape[0] - 1 - d.y, 2),
                peak_mjy_sr=round(d.peak, 4),
                snr=round(d.snr, 1),
                saturated=d.saturated,
                match=match,
                catalog_id=star.catalog_id if star else None,
                separation_arcsec=round(separation, 2) if star else None,
                catalog_mag=round(star.mag, 3) if star and star.mag is not None else None,
                catalog_band=("G" if match == "gaia" else "W1") if star else None,
            )
        )
    return sources


def find_sources(
    frames: list[Aligned],
    mjds: list[float],
    grid: WCS,
    shape: tuple[int, int],
    ra: float,
    dec: float,
    size_deg: float,
    cache_dir: Path,
) -> tuple[list[list[DetectedSource]], list[Check]]:
    """Sources of every frame, matched against one catalogue query per field; plus their checks."""
    found = [detect(frame) for frame in frames]
    if not any(detections for detections, _ in found):
        return [[] for _ in frames], []
    # Half the diagonal of the grid: the cone covers every corner.
    radius_deg = round(size_deg * ROTATION_MARGIN / 2, 4)
    gaia, allwise = field_catalogs(ra, dec, radius_deg, cache_dir)
    sources = [
        label(detections, grid, shape, mjd, gaia, allwise)
        for (detections, _), mjd in zip(found, mjds, strict=True)
    ]
    capped = sum(cut for _, cut in found)
    return sources, source_checks(sources, capped, radius_deg, gaia, allwise)


def source_checks(
    sources: list[list[DetectedSource]],
    capped: int,
    radius_deg: float,
    gaia: list[CatalogStar] | None,
    allwise: list[CatalogStar] | None,
) -> list[Check]:
    labels = [source.match for frame in sources for source in frame]
    counts = {name: labels.count(name) for name in ("gaia", "allwise", "none", "unknown")}

    def status(name: str, stars: list[CatalogStar] | None) -> str:
        if stars is None:
            return f"{name} unavailable"
        # Chance that a random position has a catalogue source within the match radius.
        chance = 1 - np.exp(-len(stars) * (MATCH_RADIUS_ARCSEC / 3600 / radius_deg) ** 2)
        if len(stars) >= MAX_CATALOG_ROWS:
            kept = "brightest" if name == "Gaia DR3" else "nearest"
            return (
                f"{name} cut at the {MAX_CATALOG_ROWS} {kept}, so unmatched sources are unknown "
                f"(≥{chance:.0%} chance match)"
            )
        return f"{name} {len(stars)} sources ({chance:.0%} chance match)"

    cap = f", the cap was reached in {capped} frames" if capped else ""
    checks = [
        Check(
            code="SOURCES",
            severity="info",
            message="Sources detected in every frame and compared with catalogues",
            detail=f"{len(labels)} detections in {len(sources)} frames at ≥{THRESHOLD_SIGMA:g}σ "
            f"in a PSF-matched S/N map (sky measured locally as the {SKY_BOX_PX} px median, so "
            "extended sources such as comae lose part of their peak; noise from the VARIANCE "
            "planes, scaled to the measured scatter; masked pixels left out, too large a masked "
            "core placed by its rim unless the grid edge cuts it; "
            f"PSF FWHM {FWHM_PX:g} px, at most {MAX_SOURCES} brightest per frame{cap}): "
            f"{counts['gaia']} Gaia DR3 match, {counts['allwise']} AllWISE match, "
            f"{counts['none']} no catalogue match - needs verification, "
            f"{counts['unknown']} unknown. Match radius {MATCH_RADIUS_ARCSEC:.1f}″ "
            f"({MATCH_RADIUS_PX:g} px), for stars brighter than G {BRIGHT_MAG['gaia']:g} / "
            f"W1 {BRIGHT_MAG['allwise']:g} within {BRIGHT_RADIUS_PX:g} px: their saturated cores "
            "are masked, only the wings place them. The brightest catalogue source within the "
            "radius wins; a match "
            "can be a chance alignment. Gaia DR3 positions are moved to each frame's date; AllWISE "
            "positions are from about 2010, so a fast-moving source can miss its match. "
            "Catalogues (chance match = a random position has a source within 1 px): "
            f"{status('Gaia DR3', gaia)}, {status('AllWISE', allwise)}",
        )
    ]
    if gaia is None or allwise is None:
        missing = " and ".join(
            name for name, stars in (("Gaia DR3", gaia), ("AllWISE", allwise)) if stars is None
        )
        checks.append(
            Check(
                code="SOURCES_CATALOG_UNAVAILABLE",
                severity="info",
                message="Catalogue unavailable for source matching",
                detail=f"{missing} did not answer within {CATALOG_TIMEOUT_S:g} s: sources it "
                "could have matched are labelled unknown",
            )
        )
    return checks
