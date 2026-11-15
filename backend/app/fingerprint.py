"""Spectral fingerprint of a possible track: forced photometry at its predicted positions in the
SPHEREx visits of every detector, joined to a quick-look spectrum with a methane index.

SPHEREx images a position with two detectors at a time (D1–D3 and D4–D6 behind a dichroic) and
with the others on other dates. Along one track (a follow-up's best distance, or its straight
line) the visits of all six detectors join to a spectrum from 0.75 to 5 µm. Deep CH₄ bands mark
T and Y brown dwarfs, cold giant planets and methane ice: a candidate to look at closer, never an
identification.
"""

import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app import followup, tasks
from app.archive import collection_key, search_observations, spherex_collections
from app.config import get_settings
from app.frames import R_BY_DETECTOR, SPHEREX_PIXEL_SCALE_ARCSEC
from app.models import (
    Check,
    Fingerprint,
    FingerprintPoint,
    MethaneBand,
    MethaneIndex,
    Observation,
    SpectralWindow,
)
from app.photometry import APERTURE_RADIUS_PX
from app.tracks import unit

# Bump whenever the measurement or the result changes: the job key changes, so results are rebuilt.
VERSION = 1
# A PSF fitted beside the object loses flux, and differently per detector as the PSF changes with
# wavelength, which would bend the spectrum: only predictions good to one pixel (2σ search circle
# plus model error) are measured.
MAX_POSITION_ARCSEC = SPHEREX_PIXEL_SCALE_ARCSEC
# Visits per window of the methane index; the rest of the budget spreads over all detectors.
WINDOW_VISITS = 6
# A window needs this many visits, a continuum this S/N, before a depth means something.
MIN_POINTS = 2
MIN_CONTINUUM_SNR = 3.0
ABSORPTION_SIGMA = 3.0
HINT_SIGMA = 2.0
# CH₄ absorbs in every band: one band below its continuum (water ice, an asteroid's heat) is no
# CH₄. A band counts at this σ.
DIP_SIGMA = 1.0


@dataclass(frozen=True)
class Window:
    code: str
    name: str
    lo_um: float
    hi_um: float
    kind: str

    def holds(self, wavelength: float | None) -> bool:
        return wavelength is not None and self.lo_um <= wavelength <= self.hi_um


# The CH₄ bands of cold atmospheres and the flux peaks between them (µm). T dwarf indices measure
# CH₄ at 1.635–1.675 and 2.215–2.255 against 1.56–1.60 and 2.08–2.12 (Burgasser et al. 2006, ApJ
# 637, 1067, table 3); the bands reach to 1.8 and 2.4 µm. Both stop short of what cool stars show
# there: the first at 1.75, where the water band of M and L dwarfs begins, the second at 2.29,
# before the CO bandhead at 2.2935. The ν3 band at 3.3 µm appears from late L dwarfs on (Noll et
# al. 2000, ApJ 541, L75) and is deep in T and Y dwarfs (Beiler et al. 2023, ApJL 951, L48).
# Neptune-like atmospheres and methane ice (Pluto, Eris) absorb in the same bands. The continua:
# the H and K peaks, clear of the water bands at 1.4 and 1.9 µm, and the 4 µm window past the
# 3.3 µm band and before CO₂ at 4.3 µm, where T and Y dwarfs are brightest.
H_PEAK = Window("h_peak", "H peak", 1.54, 1.60, "continuum")
CH4_1_7 = Window("ch4_1.7", "CH₄ 1.7 µm", 1.63, 1.75, "band")
K_PEAK = Window("k_peak", "K peak", 2.06, 2.16, "continuum")
CH4_2_25 = Window("ch4_2.25", "CH₄ 2.25 µm", 2.20, 2.29, "band")
CH4_3_3 = Window("ch4_3.3", "CH₄ 3.3 µm", 3.20, 3.50, "band")
PEAK_4UM = Window("peak_4um", "4 µm peak", 3.90, 4.15, "continuum")
WINDOWS = (H_PEAK, CH4_1_7, K_PEAK, CH4_2_25, CH4_3_3, PEAK_4UM)
# Each band against the power law through a continuum window on either side: a smooth spectrum
# (a star, any blackbody, which bends the other way in log-log) gives no depth.
BANDS = ((CH4_1_7, H_PEAK, K_PEAK), (CH4_2_25, K_PEAK, PEAK_4UM), (CH4_3_3, K_PEAK, PEAK_4UM))
SUMMARY = {
    "not_enough_channels": "CH₄ index: not enough channels",
    "continuum_too_faint": "CH₄ index: continuum too faint",
    "no_total_flux": "CH₄ index: needs PSF fluxes, and some cutouts carry no ePSF",
}

# One point of the index: wavelength (µm), total flux and its 1σ error (µJy), its visit (_visit).
IndexPoint = tuple[float, float, float, str]


def build_fingerprint(
    ra: float,
    dec: float,
    detector: int,
    marked: list[list],
    marks: list[list[float]] | None = None,
    distances: list[float] | None = None,
    points: list[list[float]] | None = None,
    collections: list[str] | None = None,
) -> dict:
    """Worker job: flux where one track puts the object in the visits of every detector, as a
    spectrum with a methane index. distances holds the one distance of a grid's marks."""
    settings = get_settings()
    collections = collections or spherex_collections(settings)

    def search(at_ra: float, at_dec: float) -> tuple[list[Observation], list[str]]:
        return search_observations(at_ra, at_dec, settings, collections)

    def planner(found: list[Observation]) -> followup.Plan:
        return plan(found, marked, detector, marks, distances, points)

    planned, failed = followup.searched(search, ra, dec, planner, tasks.report, "visits")
    tasks.report(0, len(planned.cutouts))
    downloaded, checks = tasks.download_cutouts(
        [cutout.visit for cutout in planned.cutouts],
        [cutout.url for cutout in planned.cutouts],
        settings,
    )
    checks += tasks.release_checks([obs for obs, _, _ in downloaded], failed)
    return evaluate(
        planned,
        downloaded,
        checks,
        collection=collection_key(collections),
        ra=ra,
        dec=dec,
        detector=detector,
        complete=len(downloaded) == len(planned.cutouts) and not failed,
    ).model_dump()


def plan(
    observations: list[Observation],
    marked: list[list],
    detector: int,
    marks: list[list[float]] | None = None,
    distances: list[float] | None = None,
    points: list[list[float]] | None = None,
) -> followup.Plan:
    """The cutouts along one track in the visits of every detector (followup.plan for one
    hypothesis): the windows of the methane index first, then the other wavelengths."""
    found = followup.predictions(
        observations,
        marked,
        marks,
        distances,
        points,
        detector=detector,
        max_radius=MAX_POSITION_ARCSEC,
    )
    usable = [v for v in range(len(found.visits)) if found.ok[0, v]]
    expected = {v: planned_wavelength(found.visits[v], found.units[0, v]) for v in usable}
    chosen = sorted(
        choose(found.visits, usable, expected),
        key=lambda v: (found.visits[v].mjd, found.visits[v].detector),
    )
    cutouts = [followup.cutout_around(found.visits[v], v, [0], found.units[:, v]) for v in chosen]
    reasons = Counter(found.reasons)
    if thinned := len(usable) - len(chosen):
        reasons["thinned"] += thinned
    in_windows = sum(any(w.holds(expected[v]) for w in WINDOWS) for v in chosen)
    checks = followup.not_covered(found, "visit")
    checks.append(
        Check(
            code="FINGERPRINT_PLANNED",
            severity="info",
            message="Visits chosen for the spectrum",
            detail=f"{len(chosen)} of {len(usable)} visits whose position is good to one pixel "
            f"({MAX_POSITION_ARCSEC}″: 2σ search circle plus model error), {in_windows} of them "
            f"in the windows of the CH₄ index: up to {WINDOW_VISITS} per window, the rest of at "
            f"most {followup.MAX_CUTOUTS} cutouts spread over the detectors and their "
            "wavelengths. Each visit's wavelength is estimated before downloading from where "
            "the track crosses its image; every point's wavelength comes from its cutout's "
            "WCS-WAVE table",
        )
    )
    if marks is not None:
        checks += followup.model_checks(distances[0], found.limit)
    return followup.Plan(
        found.model,
        found.distances,
        found.ra,
        found.dec,
        found.radius,
        found.error,
        [0],
        cutouts,
        checks,
        found.elsewhere,
        visits_total=found.candidates,
        reasons=reasons,
    )


def choose(
    visits: list[Observation], usable: list[int], expected: dict[int, float | None]
) -> list[int]:
    """Up to WINDOW_VISITS visits per window of the methane index by their expected wavelength,
    then the rest of MAX_CUTOUTS shared fairly between the detectors, each spread over its
    wavelengths."""
    chosen: list[int] = []
    for window in WINDOWS:
        inside = sorted((v for v in usable if window.holds(expected[v])), key=expected.get)
        chosen += _evenly(inside, WINDOW_VISITS)
    taken = set(chosen)
    groups: dict[int, list[int]] = {}
    for v in sorted(usable, key=lambda v: (expected[v] is None, expected[v] or 0.0)):
        if v not in taken:
            groups.setdefault(visits[v].detector, []).append(v)
    ordered = [groups[d] for d in sorted(groups)]
    shares = _shares([len(group) for group in ordered], followup.MAX_CUTOUTS - len(chosen))
    for group, share in zip(ordered, shares, strict=True):
        chosen += _evenly(group, share)
    return chosen


def _shares(sizes: list[int], budget: int) -> list[int]:
    """The budget dealt out one at a time, round the groups, until it or the groups run out."""
    shares = [0] * len(sizes)
    while budget > 0 and any(share < size for share, size in zip(shares, sizes, strict=True)):
        for i, size in enumerate(sizes):
            if budget > 0 and shares[i] < size:
                shares[i] += 1
                budget -= 1
    return shares


def _evenly(items: list[int], count: int) -> list[int]:
    if len(items) <= count:
        return list(items)
    if count <= 0:
        return []
    return [items[i] for i in np.unique(np.linspace(0, len(items) - 1, count).round().astype(int))]


def planned_wavelength(obs: Observation, point: np.ndarray) -> float | None:
    """The wavelength a visit sees at `point` (unit vector), estimated before downloading.

    IRSA's s_region lists the detector corners (0, 0), (W, 0), (W, H), (0, H) in this order, and
    SPHEREx's linear variable filter runs along the detector's y axis from em_max at the first row
    to em_min at the last (analysis-service/app/footprint.py and spectral.py, checked there
    against cutouts in tests/test_network.py). Evenly in log λ this stays within about 0.04 µm of
    the archive's WCS-WAVE tables, a resolution element at most: enough to choose visits.
    """
    corners = followup.polygon(obs.s_region)
    if corners is None or len(corners) != 4:
        return None
    _, v = _unit_square(corners, point)
    if not math.isfinite(v):
        return None
    v = min(max(v, 0.0), 1.0)
    return obs.wavelength_max_um * (obs.wavelength_min_um / obs.wavelength_max_um) ** v


def _unit_square(corners: np.ndarray, point: np.ndarray) -> tuple[float, float]:
    """(u, v) of `point` in the bilinear map from the unit square onto the corners, on the plane
    tangent at their centre (Newton's method; a few steps for a SPHEREx image)."""
    centre = corners.sum(axis=0)
    centre /= np.linalg.norm(centre)
    if point @ centre <= 0:
        return math.nan, math.nan
    flat = corners / (corners @ centre)[:, None]
    across = flat[1] - flat[0]
    across -= (across @ centre) * centre
    across /= np.linalg.norm(across)
    up = np.cross(centre, across)
    q = np.stack([flat @ across, flat @ up], axis=1)
    target = point / (point @ centre)
    goal = np.array([target @ across, target @ up])
    u = v = 0.5
    for _ in range(20):
        f = (1 - u) * (1 - v) * q[0] + u * (1 - v) * q[1] + u * v * q[2] + (1 - u) * v * q[3]
        f -= goal
        du = (1 - v) * (q[1] - q[0]) + v * (q[2] - q[3])
        dv = (1 - u) * (q[3] - q[0]) + u * (q[2] - q[1])
        try:
            step = np.linalg.solve(np.column_stack([du, dv]), f)
        except np.linalg.LinAlgError:
            return math.nan, math.nan
        u, v = u - float(step[0]), v - float(step[1])
        if np.abs(step).max() < 1e-10:
            break
    return u, v


def evaluate(
    plan: followup.Plan,
    downloaded: list[tuple[Observation, str, Path]],
    checks: list[Check],
    *,
    collection: str,
    ra: float,
    dec: float,
    detector: int,
    complete: bool,
) -> Fingerprint:
    """Measure every planned visit and read the methane index off the spectrum."""
    files, unreadable = followup.open_cutouts(plan.cutouts, downloaded, "fingerprint", True)
    rows = []
    for cutout, path, missing in files:
        measurement, aperture, fitted = followup.measure(plan, cutout, 0, path, missing)
        v = cutout.column
        expected = planned_wavelength(cutout.visit, unit(plan.ra[0, v], plan.dec[0, v]))
        point = FingerprintPoint(
            **measurement.model_dump(),
            detector=cutout.visit.detector,
            planned_wavelength_um=None if expected is None else round(expected, 4),
        )
        point.window = next((w.code for w in WINDOWS if w.holds(point.wavelength_um)), None)
        rows.append((point, aperture, fitted))
    # PSF fluxes are totals, whatever the detector's PSF; aperture fluxes are not: only PSF
    # fluxes join the detectors into one spectrum. Without any flux there is nothing to join.
    measured = [point for point, *_ in rows if point.skipped is None]
    psf = bool(measured) and all(point.psf_flux_ujy is not None for point in measured)
    usable = [
        (point.wavelength_um, fitted[1], fitted[2], _visit(point))
        for point, _, fitted in rows
        if psf and fitted is not None and point.wavelength_um is not None
    ]
    methane = methane_index(usable, total=psf or not measured)
    points = sorted(
        (point for point, *_ in rows),
        key=lambda p: (p.wavelength_um is None, p.wavelength_um or 0.0, p.mjd),
    )
    checks = checks + unreadable
    # A flux with flagged pixels is drawn, but it is no usable point.
    flux = {_visit(p) for p in measured if not p.flagged}
    return Fingerprint(
        collection=collection,
        ra=ra,
        dec=dec,
        detector=detector,
        model=plan.model,
        distance_au=plan.distances[0],
        complete=complete and plan.complete and not unreadable,
        psf_photometry=psf,
        visits_total=plan.visits_total,
        visits_measured=len(flux),
        windows=[
            SpectralWindow(code=w.code, name=w.name, lo_um=w.lo_um, hi_um=w.hi_um, kind=w.kind)
            for w in WINDOWS
        ],
        points=points,
        methane=methane,
        checks=plan.checks + checks + _checks(points, usable, methane, psf),
    )


def methane_index(points: list[IndexPoint], total: bool = True) -> MethaneIndex:
    """Depth of each CH₄ band below the power law through its continuum windows, and the bands'
    combined significance in σ."""
    if not total:
        return MethaneIndex(verdict="no_total_flux", summary=SUMMARY["no_total_flux"])
    means = {window.code: _mean(points, window) for window in WINDOWS}
    bands, terms = [], []
    for band, blue, red in BANDS:
        result, term = _depth(band, blue, red, means)
        bands.append(result)
        if term is not None:
            terms.append(term)
    if not terms:
        lacking = any(band.status == "not_enough_channels" for band in bands)
        verdict = "not_enough_channels" if lacking else "continuum_too_faint"
        return MethaneIndex(verdict=verdict, summary=SUMMARY[verdict], bands=bands)
    sigma = round(_combined(terms), 2)
    dips = [band for band in bands if band.sigma is not None and band.sigma >= DIP_SIGMA]
    if sigma >= ABSORPTION_SIGMA and len(dips) >= 2:
        verdict = "absorption"
        summary = (
            f"CH₄ absorption {sigma:.1f}σ in {len(dips)} bands – as in T/Y brown dwarfs or a cold "
            "giant planet; a candidate to check with more visits, not an identification"
        )
    elif sigma >= ABSORPTION_SIGMA:
        verdict = "hint"
        name = next(w.name for w in WINDOWS if w.code == dips[0].band) if dips else "one band"
        summary = (
            f"Absorption in one band only ({name}) – not enough for CH₄; check with more visits"
        )
    elif sigma >= HINT_SIGMA:
        verdict = "hint"
        summary = f"CH₄ absorption only {sigma:.1f}σ – not significant; check with more visits"
    elif sigma > -HINT_SIGMA:
        verdict = "none"
        summary = f"No CH₄ absorption ({sigma:.1f}σ) – smooth within the errors"
    else:
        verdict = "none"
        summary = (
            f"No CH₄ absorption – the bands lie above the continuum ({sigma:.1f}σ), as in a star"
        )
    return MethaneIndex(verdict=verdict, sigma=sigma, summary=summary, bands=bands)


def _visit(point: FingerprintPoint) -> str:
    """One image: an exposure's obs_id names the images of both detectors that took it."""
    return f"{point.obs_id} D{point.detector}"


@dataclass
class _Mean:
    """Inverse-variance weighted mean flux of the points in one window."""

    flux: float
    error: float
    log_wavelength: float
    count: int


@dataclass
class _Term:
    """One band's continuum minus band flux, its variance without the continuum's, and the
    continuum's derivatives by its windows' fluxes with their errors."""

    difference: float
    band_variance: float
    gradient: dict[str, tuple[float, float]]


def _mean(points: list[IndexPoint], window: Window) -> _Mean:
    inside = np.array([(w, f, e) for w, f, e, _ in points if window.holds(w)]).reshape(-1, 3)
    if not len(inside):
        return _Mean(math.nan, math.nan, math.nan, 0)
    weight = inside[:, 2] ** -2.0
    total = weight.sum()
    return _Mean(
        float(np.sum(weight * inside[:, 1]) / total),
        float(total**-0.5),
        float(np.sum(weight * np.log(inside[:, 0])) / total),
        len(inside),
    )


def _depth(
    band: Window, blue: Window, red: Window, means: dict[str, _Mean]
) -> tuple[MethaneBand, _Term | None]:
    inside, left, right = means[band.code], means[blue.code], means[red.code]
    result = MethaneBand(
        band=band.code,
        continuum=[blue.code, red.code],
        status="measured",
        points=inside.count,
        continuum_points=[left.count, right.count],
    )
    if min(inside.count, left.count, right.count) < MIN_POINTS:
        result.status = "not_enough_channels"
        return result, None
    if min(left.flux / left.error, right.flux / right.error) < MIN_CONTINUUM_SNR:
        result.status = "continuum_too_faint"
        return result, None
    # The power law through both continuum windows, at the band's mean wavelength.
    t = (inside.log_wavelength - left.log_wavelength) / (right.log_wavelength - left.log_wavelength)
    continuum = math.exp((1 - t) * math.log(left.flux) + t * math.log(right.flux))
    gradient = {
        blue.code: ((1 - t) * continuum / left.flux, left.error),
        red.code: (t * continuum / right.flux, right.error),
    }
    continuum_variance = sum((g * error) ** 2 for g, error in gradient.values())
    ratio = inside.flux / continuum
    # The σ tests "no absorption" (band flux = continuum), so it takes the errors as they are
    # there; the depth's own error is propagated at the measured ratio.
    sigma = (continuum - inside.flux) / math.sqrt(inside.error**2 + continuum_variance)
    result.flux_ujy = round(inside.flux, 2)
    result.continuum_ujy = round(continuum, 2)
    result.depth = round(1 - ratio, 3)
    result.depth_err = round(
        math.sqrt(inside.error**2 + ratio**2 * continuum_variance) / continuum, 3
    )
    result.sigma = round(sigma, 2)
    return result, _Term(continuum - inside.flux, inside.error**2, gradient)


def _combined(terms: list[_Term]) -> float:
    """Stouffer's sum of the bands' σ, divided by its spread under "no absorption": bands that
    share a continuum window are correlated (Strube 1985), so their σ do not simply add."""
    covariance = np.diag([term.band_variance for term in terms])
    for i, a in enumerate(terms):
        for j, b in enumerate(terms):
            covariance[i, j] += sum(
                g * b.gradient[w][0] * error**2
                for w, (g, error) in a.gradient.items()
                if w in b.gradient
            )
    spread = np.sqrt(np.diag(covariance))
    z = np.array([term.difference for term in terms]) / spread
    correlation = covariance / np.outer(spread, spread)
    return float(z.sum() / np.sqrt(correlation.sum()))


def _checks(
    points: list[FingerprintPoint], usable: list[IndexPoint], methane: MethaneIndex, psf: bool
) -> list[Check]:
    checks = []
    with_flux = [p for p in points if p.skipped is None]
    if not with_flux:
        checks.append(
            Check(
                code="FINGERPRINT_NO_FLUX",
                severity="error",
                message="No usable flux along the track",
                detail="No visit gave a flux at the predicted position",
            )
        )
    # A cutout the archive did not deliver already has its own CUTOUT_MISSING check.
    lost = Counter(
        p.skipped for p in points if p.skipped not in (None, followup.MISSING, followup.UNREADABLE)
    )
    for p in with_flux:
        if p.flagged:
            lost["flagged pixels in the aperture (left out)"] += 1
        elif p.wavelength_um is None:
            lost["no WCS-WAVE table"] += 1
    if lost:
        checks.append(
            Check(
                code="FINGERPRINT_SKIPPED",
                severity="info",
                message="Some visits give no spectrum point",
                detail=f"{lost.total()} visits without a usable point: "
                + ", ".join(f"{n} {reason}" for reason, n in lost.most_common()),
            )
        )
    if with_flux:
        checks.append(
            Check(
                code="FINGERPRINT_QUICK_LOOK",
                severity="info",
                message="Quick-look spectrum along the track, not calibrated",
                detail=(
                    "PSF flux (the SPHEREx ePSF of each visit's detector zone fitted at the "
                    "predicted position, total flux)"
                    if psf
                    else f"Aperture flux ({APERTURE_RADIUS_PX:g} px radius) without aperture "
                    "correction: not every cutout carries an ePSF, so the PSF's change between "
                    "detectors bends the spectrum and no CH₄ index is given"
                )
                + " at the wavelength each cutout's WCS-WAVE table gives there. Every point is "
                "another visit, days to months apart: variability, rotation and the changing "
                "phase angle shape the spectrum too",
            )
        )
    off = [
        abs(p.wavelength_um - p.planned_wavelength_um) * R_BY_DETECTOR[p.detector] / p.wavelength_um
        for p in points
        if p.wavelength_um is not None and p.planned_wavelength_um is not None
    ]
    if off and float(np.median(off)) > 1:
        checks.append(
            Check(
                code="FINGERPRINT_PLAN_OFF",
                severity="warning",
                message="Visits were chosen by a wrong wavelength estimate",
                detail=f"The wavelengths measured lie a median {float(np.median(off)):.1f} "
                "resolution elements from the ones expected from the visits' footprints, so the "
                "windows of the CH₄ index hold fewer visits than planned",
            )
        )
    checks.append(
        Check(
            code="FINGERPRINT_METHANE",
            severity="info",
            message=methane.summary,
            detail=_methane_detail(methane),
        )
    )
    if methane.verdict == "absorption":
        # Only the same bands compare: without a visit whose window then holds too few channels a
        # band drops out, which says nothing about which visit carries the absorption.
        bands = _measured(methane)
        without = []
        for label in sorted({u[3] for u in usable if any(w.holds(u[0]) for w in WINDOWS)}):
            index = methane_index([u for u in usable if u[3] != label])
            if _measured(index) == bands and index.verdict != "absorption":
                without.append((index.sigma, label, index.summary))
        if without:
            _, label, summary = min(without)
            point = next(p for p in points if _visit(p) == label)
            checks.append(
                Check(
                    code="FINGERPRINT_ONE_VISIT",
                    severity="warning",
                    message="The CH₄ absorption rests on one visit",
                    detail=f"Without {label}: {summary}. A star, an asteroid or an artefact in "
                    "that image can mimic the absorption; look at its cutout",
                    affects=[f"obs:{point.obs_id}", f"detector:{point.detector}"],
                )
            )
    return checks


def _measured(index: MethaneIndex) -> list[str]:
    return [band.band for band in index.bands if band.status == "measured"]


def _methane_detail(methane: MethaneIndex) -> str:
    names = {window.code: window.name for window in WINDOWS}
    parts = []
    for band in methane.bands:
        name, (blue, red) = names[band.band], (names[code] for code in band.continuum)
        if band.status == "measured":
            parts.append(
                f"{name}: depth {band.depth:.2f} ± {band.depth_err:.2f} ({band.sigma:.1f}σ, "
                f"{band.points} visits against {band.continuum_points[0]} in the {blue} and "
                f"{band.continuum_points[1]} in the {red})"
            )
        elif band.status == "not_enough_channels":
            parts.append(
                f"{name}: not enough channels ({band.points} visits in the band, "
                f"{band.continuum_points[0]} in the {blue}, {band.continuum_points[1]} in the "
                f"{red}; {MIN_POINTS} each needed)"
            )
        else:
            parts.append(
                f"{name}: continuum too faint (below S/N {MIN_CONTINUUM_SNR:g} in the {blue} or "
                f"the {red})"
            )
    method = (
        "Depth = 1 − band flux / continuum, the continuum a power law through the windows on "
        "either side, so a smooth spectrum such as a star's gives none; the σ test the band "
        "against that continuum and combine with their shared windows taken into account. "
        "Methane ice on a dwarf planet (Pluto, Eris) absorbs in the same bands; water ice (its "
        "3 µm band, common on Kuiper-belt objects) and an asteroid's own heat beyond 3.5 µm "
        "deepen the 3.3 µm window, so CH₄ needs two bands below their continuum. A very cold "
        "planet can lose its methane to clouds (Fortney et al. 2016, ApJL 824, L25): no dip "
        "rules nothing out"
    )
    return "; ".join(parts) + (". " if parts else "") + method
