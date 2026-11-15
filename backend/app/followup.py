"""Follow-up of a possible track: forced photometry at the other SPHEREx visits of one detector.

A hypothesis is an assumed distance from tracks.py, or one straight line whose position at each
visit the client computes (frontend/src/track.ts). The fluxes at its predicted positions are
combined over the visits (shift-and-stack): flux along one hypothesis makes a candidate worth
checking, never a detection.
"""

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import get_args

import numpy as np
from astropy.io import fits
from scipy.special import ndtri_exp
from scipy.stats import norm

from app.archive import ArchiveError, select_frames
from app.frames import SPHEREX_PIXEL_SCALE_ARCSEC, cutout_url, wavelength_at
from app.models import (
    TRACK_WINDOW_DAYS,
    Check,
    Followup,
    FollowupHypothesis,
    FollowupMeasurement,
    NotCoveredReason,
    Observation,
)
from app.photometry import (
    APERTURE_RADIUS_PX,
    SKIP_EDGE,
    SKIP_VARIANCE,
    forced_photometry,
    psf_photometry,
)
from app.tracks import ARCSEC_PER_RAD, ECCENTRICITY, MODEL, model_error, predict, unit

# Bump whenever the measurement or the result changes: the job key changes, so results are rebuilt.
VERSION = 3
# Every cutout is one IRSA request that opens a whole SPHEREx image.
MAX_CUTOUTS = 48
# Around each prediction: the aperture and its sky ring with a margin, as for a spectrum.
CUTOUT_DEG = 0.03
# Where predictions leave the field's images, the archive is searched again: one search per
# group of predictions within SEARCH_GROUP_DEG, well inside a 3.5° SPHEREx image.
MAX_SEARCHES = 4
SEARCH_GROUP_DEG = 1.0
APERTURE_ARCSEC = APERTURE_RADIUS_PX * SPHEREX_PIXEL_SCALE_ARCSEC
# Beyond the aperture's diameter the object may lie outside the aperture: the flux at the
# predicted point would test nothing there.
MAX_RADIUS_ARCSEC = 2 * APERTURE_ARCSEC
# SPHEREx exposures last about 115 s: a visit this close to a mark's time is the marked one.
SAME_VISIT_DAYS = 1 / 1440
MIN_VISITS = 2
SIGNIFICANT_SNR = 5.0
STRAIGHT_LINE = "straight line through the marks, positions per visit from the client"
# SPHEREx orbits about 7,000 km from the geocentre the predictions are made for.
ORBIT_AU = 7000 / 1.495978707e8
MISSING = "archive did not deliver the cutout"
UNREADABLE = "archive sent no readable FITS"
_NUMBER = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")
# Followup.not_covered_reasons in their order.
REASONS: tuple[str, ...] = get_args(NotCoveredReason)
MARKED = "marked (their pixels made the marks)"
REPEATED = "listed again by another release (counted once)"
BEYOND = f"more than {TRACK_WINDOW_DAYS} days from the marks"
UNPREDICTED = "without a predicted position"

# Usable flux of one hypothesis at one visit: obs_id, flux and 1σ error (µJy), unit vector.
Usable = tuple[str, float, float, np.ndarray]
# One measurement with its usable aperture and PSF fluxes (None where not combinable).
Row = tuple[FollowupMeasurement, Usable | None, Usable | None]
Search = Callable[[float, float], tuple[list[Observation], list[str]]]


@dataclass
class Cutout:
    visit: Observation
    url: str
    # The visit's column in the plan's arrays and the hypotheses measured in this cutout.
    column: int
    members: list[int]


@dataclass
class Plan:
    model: str
    distances: list[float | None]
    # Predicted positions (degrees), 2σ search radii and model errors (arcsec), hypotheses × visits.
    ra: np.ndarray
    dec: np.ndarray
    radius: np.ndarray
    error: np.ndarray
    kept: list[int]
    cutouts: list[Cutout]
    checks: list[Check]
    # Where predictions that could be tested lie outside their visit's image: search positions.
    elsewhere: list[tuple[float, float]]
    # False when an archive search did not answer: the next request tries again.
    complete: bool = True
    # Visits in the track's window that could be measured (Followup.visits_total).
    visits_total: int = 0
    # Followup.not_covered_reasons codes with the number of visits or predictions they cost.
    reasons: Counter[str] = field(default_factory=Counter)


@dataclass
class Predictions:
    """Where a track puts the object at the visits of its window, and what is left out."""

    model: str
    distances: list[float | None]
    visits: list[Observation]
    # Predicted positions (degrees), 2σ search radii and model errors (arcsec), hypotheses × visits.
    ra: np.ndarray
    dec: np.ndarray
    radius: np.ndarray
    error: np.ndarray
    units: np.ndarray
    # Precise enough and inside the visit's image: worth a cutout.
    ok: np.ndarray
    # Visits in the window that are not the marks' own (Followup.visits_total).
    candidates: int
    # What is left out, in words for FOLLOWUP_NOT_COVERED and as Followup.not_covered_reasons.
    visits_out: Counter[str]
    predictions_out: dict[str, int]
    unmatched: int
    reasons: Counter[str]
    elsewhere: list[tuple[float, float]]
    # The position limit as the checks print it, e.g. "25″".
    limit: str


def search_and_plan(
    search: Search,
    ra: float,
    dec: float,
    marked: list[list],
    marks: list[list[float]] | None = None,
    distances: list[float] | None = None,
    points: list[list[float]] | None = None,
    report: Callable[[int, int], None] = lambda done, total: None,
) -> tuple[Plan, list[str]]:
    """The visits at the field and, where predictions leave those images, at up to MAX_SEARCHES
    more positions: the plan over all of them and the collections that did not answer."""
    return searched(
        search, ra, dec, lambda found: plan(found, marked, marks, distances, points), report
    )


def searched(
    search: Search,
    ra: float,
    dec: float,
    planner: Callable[[list[Observation]], Plan],
    report: Callable[[int, int], None] = lambda done, total: None,
    visits: str = "visits of this detector",
) -> tuple[Plan, list[str]]:
    """search_and_plan for any planner, e.g. one over the visits of every detector."""
    observations, failed = search(ra, dec)
    first = planner(observations)
    positions = first.elsewhere[:MAX_SEARCHES]
    if not positions:
        return first, sorted(set(failed))
    # The extra searches can take minutes: the planned cutouts already show as the total.
    report(0, len(first.cutouts))
    known = {(obs.obs_id, obs.detector) for obs in observations}
    # Overlapping searches find the same images again; only another release's copy counts twice.
    # One exposure is one obs_id for every detector that took it.
    seen = {(obs.obs_id, obs.detector, obs.collection) for obs in observations}
    silent = 0
    for at_ra, at_dec in positions:
        try:
            more, missed = search(at_ra, at_dec)
        except ArchiveError:
            silent += 1
            continue
        new = [obs for obs in more if (obs.obs_id, obs.detector, obs.collection) not in seen]
        seen |= {(obs.obs_id, obs.detector, obs.collection) for obs in new}
        observations, failed = observations + new, failed + missed
    final = planner(observations)
    final.complete = not silent
    found = len({(obs.obs_id, obs.detector) for obs in observations} - known)
    notes = [f"{len(positions)} more searches found {found} more {visits}"]
    if silent:
        final.reasons["search_unanswered"] += silent
        notes.append(
            f"{silent} of them got no answer from the archive (requesting the same follow-up "
            "again retries them)"
        )
    if rest := len(first.elsewhere) - len(positions):
        final.reasons["not_searched"] += rest
        notes.append(f"{rest} more positions not searched (at most {MAX_SEARCHES} per job)")
    final.checks.append(
        Check(
            code="FOLLOWUP_SEARCHED",
            severity="warning" if silent else "info",
            message="Archive also searched where the track leaves the field's images",
            detail="; ".join(notes),
        )
    )
    return final, sorted(set(failed))


def plan(
    observations: list[Observation],
    marked: list[list],
    marks: list[list[float]] | None = None,
    distances: list[float] | None = None,
    points: list[list[float]] | None = None,
) -> Plan:
    """Predicted positions at the detector's other visits and the cutouts that measure them.

    marked: the marks' frames as (obs_id, first mjd, last mjd), the times None for one exposure.
    Either marks, 2 × (ra°, dec°, mjd, σ″), with the distances to assume, or points,
    (mjd, ra°, dec°, 2σ radius″), of one straight line.
    """
    found = predictions(observations, marked, marks, distances, points)
    visits, hypotheses, units, ok = found.visits, found.distances, found.units, found.ok
    radius, error, limit = found.radius, found.error, found.limit
    usable = [v for v in range(len(visits)) if ok[:, v].any()]
    kept, columns, cutouts = _fit(visits, usable, units, ok)
    reasons = Counter(found.reasons)

    checks = not_covered(found)
    thinned = []
    if len(kept) < len(hypotheses):
        thinned.append(
            f"{len(kept)} of {len(hypotheses)} distances, evenly spread in 1/d "
            "(narrow d_min_au–d_max_au for a finer grid)"
        )
        reasons["thinned"] += len(hypotheses) - len(kept)
    if len(columns) < len(usable):
        thinned.append(f"{len(columns)} of {len(usable)} visits, spread over all epochs")
        reasons["thinned"] += len(usable) - len(columns)
    if thinned:
        checks.append(
            Check(
                code="FOLLOWUP_THINNED",
                severity="info",
                message="Fewer distances or visits measured to limit downloads",
                detail=f"At most {MAX_CUTOUTS} cutouts per job: " + "; ".join(thinned),
            )
        )
    if marks is not None:
        checks += model_checks(min(hypotheses[h] for h in kept), limit)
        steps = [_largest_step(units[:, v], [h for h in kept if ok[h, v]]) for v in columns]
        if coarse := [step for step in steps if step > 2 * APERTURE_ARCSEC]:
            checks.append(
                Check(
                    code="FOLLOWUP_GRID_COARSE",
                    severity="warning",
                    message="Distances between the tested ones are missed at some visits",
                    detail=f"At {len(coarse)} visits neighbouring distances lie up to "
                    f"{max(coarse):.0f}″ apart, wider than the aperture "
                    f"({2 * APERTURE_ARCSEC:.0f}″): an object at a distance in between falls "
                    "outside every aperture there. Narrow d_min_au–d_max_au around the best "
                    "distance to test it finely",
                )
            )
    uncertain = sum(
        radius[h, c.column] + error[h, c.column] > APERTURE_ARCSEC
        for c in cutouts
        for h in c.members
    )
    if uncertain:
        checks.append(
            Check(
                code="FOLLOWUP_POSITION_UNCERTAIN",
                severity="info",
                message="Some predicted positions are uncertain",
                detail=f"{uncertain} measurements (position_uncertain) may lie more than the "
                f"aperture radius ({APERTURE_ARCSEC:.0f}″) from the object: 2σ search circle plus "
                "model error. They count, but a low flux there tests less",
            )
        )
    return Plan(
        found.model,
        hypotheses,
        found.ra,
        found.dec,
        radius,
        error,
        kept,
        cutouts,
        checks,
        found.elsewhere,
        visits_total=found.candidates,
        reasons=reasons,
    )


def predictions(
    observations: list[Observation],
    marked: list[list],
    marks: list[list[float]] | None = None,
    distances: list[float] | None = None,
    points: list[list[float]] | None = None,
    *,
    detector: int | None = None,
    max_radius: float = MAX_RADIUS_ARCSEC,
) -> Predictions:
    """The visits in the track's window and where each hypothesis puts the object there (`plan`).

    detector: the marks' detector when the observations hold every detector. Only its visits are
    the marks' own; the paired detector's image of the same exposure saw other wavelengths, and
    a straight-line position holds for every detector at its time.
    max_radius: the widest 2σ search circle plus model error (″) a prediction may have.
    """
    visits_out = Counter[str]()
    reasons = Counter[str]()
    unique: dict[tuple[str, int], Observation] = {}
    for obs in sorted(observations, key=lambda o: o.collection or ""):
        unique.setdefault((obs.obs_id, obs.detector), obs)
    if repeated := len(observations) - len(unique):
        visits_out[REPEATED] = repeated
    everyone = sorted(unique.values(), key=lambda o: o.mjd)
    times = [mark[2] for mark in marks or []]
    candidates = []
    for obs in everyone:
        if detector in (None, obs.detector) and _marked(obs, marked, times):
            visits_out[MARKED] += 1
        elif times and max(abs(obs.mjd - t) for t in times) > TRACK_WINDOW_DAYS:
            visits_out[BEYOND] += 1
            reasons["beyond_window"] += 1
        else:
            candidates.append(obs)
    unmatched = 0
    if marks is not None:
        visits = candidates
        targets = np.array([obs.mjd for obs in visits])
        ra, dec, radius = predict(np.array(marks), np.array(distances), targets)
        error = model_error(np.array(marks), np.array(distances), targets)
        model, hypotheses = MODEL, list(distances)
    else:
        allowed = {(obs.obs_id, obs.detector) for obs in candidates}
        visits, rows = [], []
        # Per detector the visit nearest to each position's time.
        detectors = sorted({obs.detector for obs in everyone})
        groups = [[obs for obs in everyone if obs.detector == d] for d in detectors]
        mjds = [np.array([obs.mjd for obs in group]) for group in groups]
        for mjd, *row in sorted(points):
            matched = False
            for group, times_of in zip(groups, mjds, strict=True):
                nearest = group[int(np.argmin(np.abs(times_of - mjd)))]
                if abs(nearest.mjd - mjd) > SAME_VISIT_DAYS:
                    continue
                matched = True
                if (nearest.obs_id, nearest.detector) in allowed:
                    allowed.discard((nearest.obs_id, nearest.detector))
                    visits.append(nearest)
                    rows.append(row)
            unmatched += not matched
        if missing := len(candidates) - len(visits):
            visits_out[UNPREDICTED] = missing
            reasons["no_prediction"] += missing
        reasons["unmatched_prediction"] += unmatched
        ra, dec, radius = np.array(rows, dtype=float).reshape(-1, 3).T[:, None, :]
        error = np.zeros_like(radius)
        model, hypotheses = STRAIGHT_LINE, [None]
    units = unit(ra, dec)
    precise = radius <= max_radius
    trusted = precise & (radius + error <= max_radius)
    inside = np.ones(radius.shape, dtype=bool)
    for v, visit in enumerate(visits):
        inside[:, v] = _inside(visit.s_region, units[:, v])
    limit = f"{max_radius:.0f}″"
    predictions_out = {
        f"with a 2σ search circle wider than {limit}": int((~precise).sum()),
        f"where the distance model can be off by more than {limit} (motion along the line "
        "of sight, the Sun's changing pull)": int((precise & ~trusted).sum()),
        "outside the visit's image": int((trusted & ~inside).sum()),
    }
    codes = ("search_circle_too_wide", "model_error_too_large", "outside_image")
    reasons.update(dict(zip(codes, predictions_out.values(), strict=True)))
    return Predictions(
        model=model,
        distances=hypotheses,
        visits=visits,
        ra=ra,
        dec=dec,
        radius=radius,
        error=error,
        units=units,
        ok=trusted & inside,
        candidates=len(candidates),
        visits_out=visits_out,
        predictions_out=predictions_out,
        unmatched=unmatched,
        reasons=+reasons,
        elsewhere=_elsewhere(units[trusted & ~inside]),
        limit=limit,
    )


def not_covered(found: Predictions, visit: str = "visit of this detector") -> list[Check]:
    """FOLLOWUP_NOT_COVERED: the visits and predictions left out, and why."""
    notes = []
    if found.visits_out:
        notes.append(
            f"{found.visits_out.total()} visits left out: "
            + ", ".join(f"{n} {reason}" for reason, n in found.visits_out.most_common())
        )
    if out := {reason: n for reason, n in found.predictions_out.items() if n}:
        notes.append(
            f"{sum(out.values())} predictions left out: "
            + ", ".join(f"{n} {reason}" for reason, n in out.items())
        )
    if found.unmatched:
        notes.append(f"{found.unmatched} predicted positions match no {visit}")
    if not notes:
        return []
    return [
        Check(
            code="FOLLOWUP_NOT_COVERED",
            severity="info",
            message="Not every visit is measured",
            detail="; ".join(notes),
        )
    ]


def model_checks(nearest_au: float, limit: str) -> list[Check]:
    """What the distance model assumes: the geocentre and orbits up to ECCENTRICITY."""
    return [
        Check(
            code="FOLLOWUP_GEOCENTRIC",
            severity="info",
            message="Positions predicted for Earth's centre",
            detail="SPHEREx orbits about 7,000 km from Earth's centre, which shifts an object "
            f"at {nearest_au:.0f} AU by up to {ORBIT_AU / nearest_au * ARCSEC_PER_RAD:.1f}″ "
            f"(one pixel is {SPHEREX_PIXEL_SCALE_ARCSEC}″); light travel time is ignored",
        ),
        Check(
            code="FOLLOWUP_MODEL_ERROR",
            severity="info",
            message=f"Orbits up to e = {ECCENTRICITY:g} assumed",
            detail=f"A distance is tested at a visit where its 2σ search circle plus the "
            f"model's error stays within {limit}: the most an orbit around the Sun with "
            f"eccentricity up to {ECCENTRICITY:g} can stray (motion along the line of sight, "
            "the Sun's changing pull). More eccentric orbits can miss the aperture",
        ),
    ]


def _marked(obs: Observation, marked: list[list], times: list[float]) -> bool:
    """A visit of a marked frame (its obs_id, or a stack's time span) or at a mark's time."""
    for obs_id, first, last in marked:
        if obs.obs_id == obs_id:
            return True
        if first is not None:
            end = first if last is None else last
            if first - SAME_VISIT_DAYS <= obs.mjd <= end + SAME_VISIT_DAYS:
                return True
    return any(abs(obs.mjd - t) <= SAME_VISIT_DAYS for t in times)


def polygon(region: str | None) -> np.ndarray | None:
    """The corners of an s_region POLYGON as unit vectors, in IRSA's order and without the first
    corner repeated at the end; None for anything else."""
    parts = (region or "").split()
    values = [float(part) for part in parts if _NUMBER.match(part)]
    if not parts or parts[0].upper() != "POLYGON" or len(values) < 6 or len(values) % 2:
        return None
    pairs = np.array(values).reshape(-1, 2)
    # IRSA closes the polygon with its first corner again.
    if len(pairs) > 3 and np.array_equal(pairs[0], pairs[-1]):
        pairs = pairs[:-1]
    return unit(*pairs.T)


def _inside(region: str | None, units: np.ndarray) -> np.ndarray:
    """Which unit vectors lie at least an aperture radius inside a visit's s_region polygon
    (convex, great-circle edges); without a polygon IRSA's cutout answer decides."""
    corners = polygon(region)
    if corners is None:
        return np.ones(len(units), dtype=bool)
    edges = np.cross(corners, np.roll(corners, -1, axis=0))
    # Repeated corners make edges without length.
    lengths = np.linalg.norm(edges, axis=1)
    edges = edges[lengths > 1e-12] / lengths[lengths > 1e-12, None]
    edges *= np.sign(edges @ corners.mean(axis=0))[:, None]
    return np.all(units @ edges.T >= np.sin(np.radians(APERTURE_ARCSEC / 3600)), axis=-1)


def _elsewhere(points: np.ndarray) -> list[tuple[float, float]]:
    """One search position per group of predictions within SEARCH_GROUP_DEG, largest first."""
    groups: list[list[np.ndarray]] = []
    for point in points:
        group = next((g for g in groups if _degrees(g[0] @ point) <= SEARCH_GROUP_DEG), None)
        if group is None:
            groups.append([point])
        else:
            group.append(point)
    return [_radec(np.sum(group, axis=0)) for group in sorted(groups, key=len, reverse=True)]


def _fit(
    visits: list[Observation], usable: list[int], units: np.ndarray, ok: np.ndarray
) -> tuple[list[int], list[int], list[Cutout]]:
    """The most hypotheses, evenly spread, whose cutouts fit MAX_CUTOUTS.

    When two hypotheses alone do not fit, fewer visits spread over all epochs: with at most
    MAX_CUTOUTS // 2 visits, two cutouts per visit always fit.
    """
    count = len(ok)
    fewest = min(count, 2)
    spread = {o.obs_id for o in select_frames([visits[v] for v in usable], MAX_CUTOUTS // fewest)}
    capped = [v for v in usable if visits[v].obs_id in spread]
    # Every visit needs a cutout: with more visits than MAX_CUTOUTS only fewer can fit.
    sets = [capped] if len(usable) > MAX_CUTOUTS else [usable, capped]
    for columns, n in [(c, n) for c in sets for n in range(count, fewest - 1, -1)]:
        kept = np.unique(np.linspace(0, count - 1, n).round().astype(int)).tolist()
        groups = [
            (v, group)
            for v in columns
            for group in _groups([h for h in kept if ok[h, v]], units[:, v])
        ]
        if len(groups) <= MAX_CUTOUTS:
            break
    return kept, columns, [cutout_around(visits[v], v, g, units[:, v]) for v, g in groups]


def _groups(members: list[int], units: np.ndarray) -> list[list[int]]:
    """Predictions within CUTOUT_DEG of a group's first one share a cutout."""
    groups: list[list[int]] = []
    for h in members:
        if groups and _degrees(units[groups[-1][0]] @ units[h]) <= CUTOUT_DEG:
            groups[-1].append(h)
        else:
            groups.append([h])
    return groups


def cutout_around(visit: Observation, column: int, group: list[int], units: np.ndarray) -> Cutout:
    """One cutout centred on its group, each prediction at least CUTOUT_DEG / 2 from the edge."""
    centre = units[group].sum(axis=0)
    reach = _degrees(np.min(units[group] @ (centre / np.linalg.norm(centre))))
    url = cutout_url(visit.access_url, *_radec(centre), 2 * reach + CUTOUT_DEG)
    return Cutout(visit, url, column, group)


def _radec(vector: np.ndarray) -> tuple[float, float]:
    x, y, z = vector / np.linalg.norm(vector)
    return float(np.degrees(np.arctan2(y, x)) % 360), float(np.degrees(np.arcsin(z)))


def _largest_step(units: np.ndarray, members: list[int]) -> float:
    """Largest separation (arcsec) between neighbouring hypotheses at one visit."""
    steps = (3600 * _degrees(units[a] @ units[b]) for a, b in pairwise(members))
    return max(steps, default=0.0)


def _degrees(cosine: float) -> float:
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def evaluate(
    plan: Plan,
    downloaded: list[tuple[Observation, str, Path]],
    checks: list[Check],
    *,
    collection: str,
    ra: float,
    dec: float,
    detector: int,
    complete: bool,
) -> Followup:
    """Measure every planned prediction and combine each hypothesis over its usable visits."""
    files, unreadable = open_cutouts(plan.cutouts, downloaded, "follow-up")
    rows: dict[int, list[Row]] = {h: [] for h in plan.kept}
    for cutout, path, missing in files:
        for h in cutout.members:
            rows[h].append(measure(plan, cutout, h, path, missing))
    # PSF fluxes are totals, aperture fluxes the core (~5 % less): one kind for every hypothesis,
    # so that their S/N compare.
    combinable = [row for h in plan.kept for row in rows[h] if row[1] is not None]
    psf = bool(combinable) and all(row[2] is not None for row in combinable)
    hypotheses, usable = [], []
    for h in plan.kept:
        ordered = sorted(rows[h], key=lambda row: row[0].mjd)
        good = [row[2] if psf else row[1] for row in ordered if row[1] is not None]
        hypothesis = FollowupHypothesis(
            distance_au=plan.distances[h], visits=len(good), measurements=[m for m, *_ in ordered]
        )
        if good:
            flux, error, snr = _stack(good)
            hypothesis.flux_ujy, hypothesis.flux_err_ujy = round(flux, 2), round(error, 2)
            hypothesis.snr = round(snr, 2)
        hypotheses.append(hypothesis)
        usable.append(good)
    candidates = [i for i, hypothesis in enumerate(hypotheses) if hypothesis.visits >= MIN_VISITS]
    best = max(candidates, key=lambda i: _stack(usable[i])[2], default=None)
    trials = _independent([usable[i] for i in candidates])
    determined = plan.model == MODEL and trials > 1
    measurements = [m for hypothesis in hypotheses for m in hypothesis.measurements]
    # A flux with flagged pixels is measured but never combined: it does not count.
    measured = {m.obs_id for m in measurements if m.skipped is None and not m.flagged}
    global_sigma = None
    if best is not None:
        global_sigma = round(_global_sigma(_stack(usable[best])[2], max(trials, 1)), 2)
    checks = checks + unreadable
    return Followup(
        collection=collection,
        ra=ra,
        dec=dec,
        detector=detector,
        model=plan.model,
        complete=complete and plan.complete and not unreadable,
        best=best,
        significant=best is not None and _stack(usable[best])[2] >= SIGNIFICANT_SNR,
        distance_determined=determined,
        psf_photometry=psf,
        hypotheses=hypotheses,
        checks=plan.checks
        + checks
        + _checks(hypotheses, usable, best, detector, trials, determined, plan.model == MODEL, psf),
        global_sigma=global_sigma,
        independent_trials=trials,
        visits_total=plan.visits_total,
        visits_measured=len(measured),
        not_covered_reasons=not_covered_reasons(plan.reasons, measurements, checks),
    )


def not_covered_reasons(
    planned: Counter[str], measurements: list[FollowupMeasurement], checks: list[Check]
) -> list[str]:
    """The REASONS that cost visits or predictions: from the plan, the measurements and the
    archive's answers."""
    found = Counter(planned)
    for m in measurements:
        if m.skipped in (MISSING, UNREADABLE):
            found["cutout_missing"] += 1
        elif m.skipped == SKIP_EDGE:
            found["image_edge"] += 1
        elif m.skipped is not None:
            found["no_flux"] += 1
        elif m.flagged:
            found["flagged_pixels"] += 1
    found["release_unavailable"] += sum(check.code == "RELEASE_UNAVAILABLE" for check in checks)
    return [reason for reason in REASONS if found[reason] > 0]


def open_cutouts(
    cutouts: list[Cutout],
    downloaded: list[tuple[Observation, str, Path]],
    job: str,
    detector: bool = False,
) -> tuple[list[tuple[Cutout, Path | None, str]], list[Check]]:
    """Each planned cutout with its file, or None and why there is none (MISSING, UNREADABLE).

    A file that is no readable FITS, e.g. an error page sent with HTTP 200, leaves the cache, so
    the next request fetches it again, and gets a CUTOUT_MISSING check; `detector` names the
    visit's detector there too, for a job over every detector (one obs_id, two detectors).
    """
    paths = {url: path for _, url, path in downloaded}
    files, checks = [], []
    for cutout in cutouts:
        path = paths.get(cutout.url)
        if path is None or readable(path):
            files.append((cutout, path, MISSING))
            continue
        path.unlink(missing_ok=True)
        files.append((cutout, None, UNREADABLE))
        obs = cutout.visit
        name, affects = obs.obs_id, [f"obs:{obs.obs_id}"]
        if detector:
            name, affects = f"{obs.obs_id} D{obs.detector}", [*affects, f"detector:{obs.detector}"]
        checks.append(
            Check(
                code="CUTOUT_MISSING",
                severity="warning",
                message="Archive did not deliver a cutout",
                detail=f"{name}: {UNREADABLE}, cutout skipped (requesting the same {job} again "
                "retries it)",
                affects=affects,
            )
        )
    return files, checks


def readable(path: Path) -> bool:
    """A FITS file with the IMAGE and VARIANCE extensions the photometry reads."""
    try:
        with fits.open(path) as hdul:
            return "IMAGE" in hdul and "VARIANCE" in hdul
    except OSError:
        return False


def measure(plan: Plan, cutout: Cutout, h: int, path: Path | None, missing: str = MISSING) -> Row:
    """Forced photometry at one prediction; the raw aperture and PSF fluxes when they can be
    combined."""
    v, obs = cutout.column, cutout.visit
    ra, dec = float(plan.ra[h, v]), float(plan.dec[h, v])
    measured = forced_photometry(path, ra, dec) if path else missing
    if not isinstance(measured, str) and not measured[1] > 0:
        measured = SKIP_VARIANCE
    wavelength, bandwidth = wavelength_at(path, ra, dec) if path else (None, None)
    point = FollowupMeasurement(
        obs_id=obs.obs_id,
        date=obs.date,
        mjd=obs.mjd,
        ra=round(ra, 6),
        dec=round(dec, 6),
        radius_arcsec=round(float(plan.radius[h, v]), 1),
        model_error_arcsec=round(float(plan.error[h, v]), 1),
        position_uncertain=bool(plan.radius[h, v] + plan.error[h, v] > APERTURE_ARCSEC),
        wavelength_um=None if wavelength is None else round(wavelength, 4),
        bandwidth_um=None if bandwidth is None else round(bandwidth, 4),
        source_url=cutout.url,
    )
    if isinstance(measured, str):
        point.skipped = measured
        return point, None, None
    flux, error, point.flagged = measured
    point.flux_ujy, point.flux_err_ujy = round(flux, 2), round(error, 2)
    point.snr = round(flux / error, 2)
    total = psf_photometry(path, ra, dec)
    if isinstance(total, tuple):
        point.psf_flux_ujy, point.psf_flux_err_ujy = round(total[0], 2), round(total[1], 2)
        point.psf_snr = round(total[0] / total[1], 2)
    if point.flagged:
        return point, None, None
    here = unit(ra, dec)
    fitted = (obs.obs_id, total[0], total[1], here) if isinstance(total, tuple) else None
    return point, (obs.obs_id, flux, error, here), fitted


def _stack(good: list[Usable]) -> tuple[float, float, float]:
    """Inverse-variance weighted mean flux, its 1σ error and their ratio."""
    flux = np.array([f for _, f, _, _ in good])
    weight = np.array([e for _, _, e, _ in good]) ** -2.0
    mean, error = np.sum(weight * flux) / np.sum(weight), np.sum(weight) ** -0.5
    return float(mean), float(error), float(mean / error)


def _independent(usables: list[list[Usable]]) -> int:
    """Independent trials among the hypotheses: at each visit, the hypotheses measured there form
    groups an aperture apart (in distance order); the visit that separates most of them counts."""
    by_visit: dict[str, list[np.ndarray]] = {}
    for good in usables:
        for obs_id, _, _, point in good:
            by_visit.setdefault(obs_id, []).append(point)
    trials = 0
    for points in by_visit.values():
        firsts = [points[0]]
        for point in points[1:]:
            if 3600 * _degrees(firsts[-1] @ point) >= APERTURE_ARCSEC:
                firsts.append(point)
        trials = max(trials, len(firsts))
    return trials


def _checks(
    hypotheses: list[FollowupHypothesis],
    usable: list[list[Usable]],
    best: int | None,
    detector: int,
    trials: int,
    determined: bool,
    distances: bool,
    psf: bool,
) -> list[Check]:
    measurements = [m for hypothesis in hypotheses for m in hypothesis.measurements]
    with_flux = [m for m in measurements if m.skipped is None]
    # A cutout the archive did not deliver already has its own CUTOUT_MISSING check.
    skipped = Counter(
        m.skipped for m in measurements if m.skipped not in (None, MISSING, UNREADABLE)
    )
    checks = []
    if best is None:
        nothing = not any(hypothesis.visits for hypothesis in hypotheses)
        checks.append(
            Check(
                code="FOLLOWUP_FEW_VISITS",
                severity="error" if nothing else "blocker",
                message="No usable flux along the track" if nothing else "Too few visits",
                detail="No visit gave a usable flux at a predicted position"
                if nothing
                else f"No hypothesis has usable fluxes from {MIN_VISITS} or more visits: one "
                "visit is no stack",
            )
        )
    if flagged := sum(m.flagged for m in with_flux):
        every = flagged == len(with_flux)
        checks.append(
            Check(
                code="FOLLOWUP_FLAGGED",
                severity="warning" if every else "info",
                message="Every flux has flagged pixels"
                if every
                else "Fluxes with flagged pixels are left out",
                detail=f"{flagged} of {len(with_flux)} fluxes have pixels the archive marks "
                "unusable in the aperture (e.g. a cosmic ray or a hot pixel, which can mimic the "
                "object): they are not combined",
            )
        )
    if edge := skipped.pop(SKIP_EDGE, 0):
        checks.append(
            Check(
                code="FOLLOWUP_EDGE",
                severity="warning",
                message="Predicted positions at the edge of the image",
                detail=f"{edge} predicted positions lie at the edge of their visit's image, where "
                "the cutout ends: no flux there",
            )
        )
    if skipped:
        checks.append(
            Check(
                code="FOLLOWUP_SKIPPED",
                severity="info",
                message="Some predicted positions give no flux",
                detail=f"{skipped.total()} without a flux: "
                + ", ".join(f"{n} {reason}" for reason, n in skipped.most_common()),
            )
        )
    if with_flux:
        wavelengths = [m.wavelength_um for m in with_flux if m.wavelength_um is not None]
        band = (
            f"{min(wavelengths):.2f}–{max(wavelengths):.2f} µm"
            if wavelengths
            else "unknown without a WCS-WAVE table"
        )
        method = (
            "PSF flux (the SPHEREx ePSF of the visit's detector zone fitted at each predicted "
            "position, total flux) combined over the visits; the aperture flux "
            f"({APERTURE_RADIUS_PX:g} px radius, no aperture correction) is listed beside it"
            if psf
            else f"Aperture flux ({APERTURE_RADIUS_PX:g} px radius) at each predicted position "
            "without aperture correction, combined over the visits: not every cutout carries an "
            "ePSF for PSF photometry"
        )
        off = sum(
            m.radius_arcsec + m.model_error_arcsec > SPHEREX_PIXEL_SCALE_ARCSEC for m in with_flux
        )
        if psf and off:
            method += (
                f". The fit assumes the predicted position: {off} of {len(with_flux)} are "
                "uncertain by more than a pixel, where it can keep about half of the flux (the "
                "aperture most of it), which lowers the S/N of a real track and adds none"
            )
        checks.append(
            Check(
                code="FOLLOWUP_QUICK_LOOK",
                severity="info",
                message="Quick-look photometry, not calibrated",
                detail=f"{method}. The visits see the object at different wavelengths of "
                f"detector {detector} ({band}), so the combination tests for flux along the "
                "track; it is no brightness",
            )
        )
    if best is not None and distances and not determined:
        checks.append(
            Check(
                code="FOLLOWUP_DISTANCE_UNDETERMINED",
                severity="warning",
                message="Distance undetermined",
                detail="At every measured visit all tested distances lie less than one aperture "
                f"({APERTURE_ARCSEC:.0f}″) apart, so the flux tests the track, not a distance; "
                "visits farther in time from the marks tell distances apart",
            )
        )
    if best is not None:
        checks += _significance(hypotheses, usable, best, trials, determined)
    return checks


def _global_sigma(snr: float, trials: int) -> float:
    """A local S/N as the significance of the best of `trials` independent tries (one-sided,
    Šidák), in logs: a bright source gives a number, not infinity."""
    log_local = norm.logsf(snr)
    if log_local < -700:  # p underflows; 1 − (1 − p)^n = n·p then
        log_global = np.log(trials) + log_local
    else:
        log_global = np.log(-np.expm1(trials * np.log1p(-np.exp(log_local))))
    return float(-ndtri_exp(log_global))


def _significance(
    hypotheses: list[FollowupHypothesis],
    usable: list[list[Usable]],
    best: int,
    trials: int,
    determined: bool,
) -> list[Check]:
    good = usable[best]
    at = f" at {hypotheses[best].distance_au:.0f} AU" if determined else ""
    snr = _stack(good)[2]
    caveats = ""
    if trials > 1:
        caveats += f"; the best of {trials} independent hypotheses is inflated by chance"
        if snr >= SIGNIFICANT_SNR:
            caveats += f": {snr:.1f}σ local ≈ {_global_sigma(snr, trials):.1f}σ global"
    high = sum(
        h.snr >= SIGNIFICANT_SNR for h in hypotheses if h.visits >= MIN_VISITS and h.snr is not None
    )
    if determined and high > 1:
        caveats += (
            f"; {high} of {len(hypotheses)} distances reach S/N {SIGNIFICANT_SNR:g}: visits close "
            "to the marks see almost the same position at every distance and lift them all, only "
            "distant visits tell the distances apart"
        )
    checks = [
        Check(
            code="FOLLOWUP_SIGNIFICANCE",
            severity="info",
            message=f"Flux along the track{at} (S/N {snr:.1f}): a candidate to check, not a "
            "detection"
            if snr >= SIGNIFICANT_SNR
            else f"No significant flux along the track (best S/N {snr:.1f}{at}, "
            f"{SIGNIFICANT_SNR:g} needed)",
            detail=f"Inverse-variance weighted flux over {len(good)} visits{caveats}. A low S/N "
            "does not rule out an object fainter than the noise",
        )
    ]
    if snr >= SIGNIFICANT_SNR:
        rest, obs_id = min(
            (_stack(good[:j] + good[j + 1 :])[2], good[j][0]) for j in range(len(good))
        )
        if rest < SIGNIFICANT_SNR:
            checks.append(
                Check(
                    code="FOLLOWUP_ONE_VISIT",
                    severity="warning",
                    message="The S/N rests on one visit",
                    detail=f"Without {obs_id} the S/N{at} drops from {snr:.1f} to {rest:.1f}: a "
                    "star, an asteroid or an artefact there can mimic the candidate; look at "
                    "that visit's cutout",
                    affects=[f"obs:{obs_id}"],
                )
            )
    return checks
