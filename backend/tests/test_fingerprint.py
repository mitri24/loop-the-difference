"""The spectral fingerprint: one track in the visits of every detector, and its methane index."""

import hashlib
import json
import math
import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from rq.exceptions import NoSuchJobError

from app import fingerprint, followup, jobs, tasks
from app.frames import SPHEREX_PIXEL_SCALE_ARCSEC, wavelength_at
from app.models import Observation
from app.tracks import predict, unit

T1 = 61000.0
FIELD = (61.2, 19.8)
# Two marks 20 days apart on detector 6; the object is at 300 AU.
MARKS = [[61.2, 19.8, T1, 0.1], [61.14, 19.79, T1 + 20, 0.1]]
DISTANCE = 300.0
DETECTOR = 6
PSF_SIGMA_PX = 0.85
# em_min and em_max per detector, as IRSA lists them (D4 and D5 from the WCS-WAVE tables).
RANGES = {
    1: (0.7455, 1.1167),
    2: (1.1033, 1.6499),
    3: (1.6301, 2.4346),
    4: (2.398, 3.863),
    5: (3.798, 4.443),
    6: (4.4115, 5.0096),
}
HALF_DEG = 1.0
CONTINUUM = 20.0
CH4 = [band for band, _, _ in fingerprint.BANDS]
CUTOUT = Path(__file__).parent / "fixtures" / "spherex_cutout_d6_wcs.fits"


def _square(ra: float, dec: float, half_deg: float) -> str:
    """An s_region as IRSA writes it: corners (0, 0), (W, 0), (W, H), (0, H), closed again."""
    dra = half_deg / np.cos(np.radians(dec))
    corners = [(ra - dra, dec - half_deg), (ra + dra, dec - half_deg)]
    corners += [(ra + dra, dec + half_deg), (ra - dra, dec + half_deg), corners[0]]
    return "POLYGON ICRS " + " ".join(f"{a:.6f} {b:.6f}" for a, b in corners)


def _track(day: float) -> tuple[float, float]:
    ra, dec, _ = predict(np.array(MARKS), np.array([DISTANCE]), np.array([T1 + day]))
    return float(ra[0, 0]), float(dec[0, 0])


def _visit(detector: int, wavelength: float, day: float, obs_id: str | None = None):
    """A visit of `detector` whose filter sees the track at `wavelength`: its image lies so that
    the track crosses the filter's row of that wavelength."""
    lo, hi = RANGES[detector]
    row = math.log(wavelength / hi) / math.log(lo / hi)
    ra, dec = _track(day)
    obs_id = obs_id or f"v{day:+.2f}"
    return Observation(
        obs_id=obs_id,
        detector=detector,
        wavelength_min_um=lo,
        wavelength_max_um=hi,
        mjd=T1 + day,
        date=f"day{day:+.2f}",
        access_url=f"https://irsa.invalid/{obs_id}D{detector}.fits",
        collection="spherex_dr1",
        s_region=_square(ra, dec - (row - 0.5) * 2 * HALF_DEG, HALF_DEG),
    ), wavelength


def _visits(wavelengths: dict[int, list[float]], start: float = 1.0):
    """Visits of every detector at the given wavelengths, one every 0.3 days between the marks."""
    pairs = [(d, w) for d in sorted(wavelengths) for w in wavelengths[d]]
    return [_visit(d, w, start + 0.3 * k) for k, (d, w) in enumerate(pairs)]


def _windows(per_window: int = 6) -> dict[int, list[float]]:
    """per_window wavelengths inside every window of the index, and two in D1 and D6 each."""
    covering = {"h_peak": 2, "ch4_1.7": 3, "k_peak": 3, "ch4_2.25": 3, "ch4_3.3": 4}
    found: dict[int, list[float]] = {1: [0.9, 1.0], 6: [4.6, 4.8]}
    for window in fingerprint.WINDOWS:
        inside = np.linspace(window.lo_um + 0.005, window.hi_um - 0.005, per_window)
        found.setdefault(covering.get(window.code, 5), []).extend(inside.round(4).tolist())
    return found


def _epsf() -> fits.BinTableHDU:
    """The archive's EPSF table with a single zone: the sky's Gaussian PSF, sampled 5× per pixel."""
    d = (np.arange(33) - 16) / 5
    g = np.exp(-(d**2) / (2 * PSF_SIGMA_PX**2))
    hdu = fits.BinTableHDU.from_columns(
        [
            fits.Column("XCENTER", "E", array=[1019.5]),
            fits.Column("YCENTER", "E", array=[1019.5]),
            fits.Column(
                "EPSF", "1089D", dim="(33,33)", array=[np.outer(g, g) / np.outer(g, g).sum()]
            ),
        ],
        name="EPSF",
    )
    hdu.header["OVSMPX"] = hdu.header["OVSMPY"] = 5
    return hdu


def _sky(monkeypatch, settings, tmp_path, visits, spectrum):
    """Offline archive: unit noise around each cutout's centre plus the object where the track
    puts it, with spectrum(wavelength) as its flux (summed MJy/sr); each visit sees it at its
    own wavelength, which the cutout's WCS-WAVE table would give."""
    seen = {obs.access_url: wavelength for obs, wavelength in visits}
    observations = [obs for obs, _ in visits]
    wavelengths, searched = {}, []

    def search(at_ra, at_dec, settings, collections):
        searched.append((at_ra, at_dec))
        return (observations if (at_ra, at_dec) == FIELD else []), []

    def fetch(client, url, directory):
        base, query = url.split("?")
        params = dict(part.split("=") for part in query.split("&"))
        size = round(float(params["size"]) * 3600 / SPHEREX_PIXEL_SCALE_ARCSEC)
        wcs = WCS(naxis=2)
        wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        wcs.wcs.crval = [float(value) for value in params["center"].split(",")]
        wcs.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
        wcs.wcs.cdelt = np.array([-1.0, 1.0]) * SPHEREX_PIXEL_SCALE_ARCSEC / 3600
        seed = int(hashlib.sha256(url.encode()).hexdigest()[:8], 16)
        path = tmp_path / f"{seed}.fits"
        image = np.random.default_rng(seed).normal(0.0, 1.0, (size, size))
        obs = next(o for o in observations if o.access_url == base)
        x, y = wcs.world_to_pixel_values(*_track(obs.mjd - T1))
        yy, xx = np.indices(image.shape)
        spread = 2 * PSF_SIGMA_PX**2
        flux = spectrum(seen[base])
        image += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / spread) / (np.pi * spread)
        fits.HDUList(
            [
                fits.PrimaryHDU(),
                fits.ImageHDU(image, wcs.to_header(), name="IMAGE"),
                fits.ImageHDU(np.ones((size, size)), name="VARIANCE"),
                _epsf(),
            ]
        ).writeto(path, overwrite=True)
        wavelengths[path] = seen[base]
        return path

    def wave(path, ra, dec):
        return wavelengths[path], wavelengths[path] / 41

    monkeypatch.setattr(fingerprint, "get_settings", lambda: settings)
    monkeypatch.setattr(fingerprint, "search_observations", search)
    monkeypatch.setattr(tasks, "fetch_cutout", fetch)
    monkeypatch.setattr(followup, "wavelength_at", wave)
    return searched


def _methane(wavelength: float) -> float:
    """A T dwarf's CH₄ bands on a flat continuum: 70 % absorbed."""
    return CONTINUUM * (0.3 if any(band.holds(wavelength) for band in CH4) else 1.0)


def _run(**changes) -> dict:
    params = {"ra": FIELD[0], "dec": FIELD[1], "detector": DETECTOR, "marked": []}
    params |= {"marks": MARKS, "distances": [DISTANCE]}
    return fingerprint.build_fingerprint(**(params | changes))


def _checks(result: dict) -> dict:
    return {check["code"]: check for check in result["checks"]}


def test_methane_bands_along_the_track_give_an_absorption_index(monkeypatch, settings, tmp_path):
    # Mark B was set on detector 6 at T1 + 20: that visit made the mark, the paired detector 3
    # saw the same patch at the same time in another band and counts.
    paired = [_visit(3, 2.11, 20, "markB"), _visit(6, 4.7, 20, "markB")]
    _sky(monkeypatch, settings, tmp_path, _visits(_windows()) + paired, _methane)

    result = _run()

    methane = result["methane"]
    assert methane["verdict"] == "absorption"
    assert methane["sigma"] >= 3
    assert methane["summary"] == (
        f"CH₄ absorption {methane['sigma']:.1f}σ – as in T/Y brown dwarfs or a cold giant planet; "
        "check with more visits"
    )
    for band in methane["bands"]:
        assert band["status"] == "measured"
        assert band["depth"] == pytest.approx(0.7, abs=3 * band["depth_err"])
        assert band["sigma"] >= 3
    assert (result["psf_photometry"], result["complete"], result["distance_au"]) == (
        True,
        True,
        DISTANCE,
    )
    points = result["points"]
    assert {p["detector"] for p in points} == {1, 2, 3, 4, 5, 6}
    assert [p["wavelength_um"] for p in points] == sorted(p["wavelength_um"] for p in points)
    assert ("markB", 3) in {(p["obs_id"], p["detector"]) for p in points}
    assert ("markB", 6) not in {(p["obs_id"], p["detector"]) for p in points}
    assert all(p["window"] is not None for p in points if p["detector"] in (2, 4, 5))
    assert all(abs(p["planned_wavelength_um"] - p["wavelength_um"]) < 0.01 for p in points)
    first = points[0]
    assert first["source_url"].startswith(f"https://irsa.invalid/{first['obs_id']}D1.fits?center=")
    assert (result["visits_total"], result["visits_measured"]) == (len(points), len(points))
    checks = _checks(result)
    assert checks["FINGERPRINT_METHANE"]["message"] == methane["summary"]
    assert "CH₄ 3.3 µm: depth 0." in checks["FINGERPRINT_METHANE"]["detail"]
    assert checks["FOLLOWUP_NOT_COVERED"]["detail"] == (
        "1 visits left out: 1 marked (their pixels made the marks)"
    )
    assert "PSF flux" in checks["FINGERPRINT_QUICK_LOOK"]["detail"]
    assert {"FINGERPRINT_PLAN_OFF", "FINGERPRINT_ONE_VISIT", "FINGERPRINT_NO_FLUX"}.isdisjoint(
        checks
    )


def test_a_flat_spectrum_gives_no_methane_index(monkeypatch, settings, tmp_path):
    _sky(monkeypatch, settings, tmp_path, _visits(_windows()), lambda wavelength: CONTINUUM)

    result = _run()

    methane = result["methane"]
    assert methane["verdict"] in ("none", "hint")
    assert methane["sigma"] < fingerprint.ABSORPTION_SIGMA
    for band in methane["bands"]:
        assert band["depth"] == pytest.approx(0.0, abs=3 * band["depth_err"])
    assert "FINGERPRINT_ONE_VISIT" not in _checks(result)


def test_smooth_spectra_give_no_depth():
    edges = [w.lo_um + (w.hi_um - w.lo_um) * k / 3 for w in fingerprint.WINDOWS for k in range(4)]

    def index(spectrum) -> dict:
        points = [(w, spectrum(w), 0.01 * spectrum(w), f"v{i}") for i, w in enumerate(edges)]
        return fingerprint.methane_index(points).model_dump()

    def planck(kelvin):
        return lambda w: 1 / (w**3 * math.expm1(14388 / (w * kelvin)))

    # A star's Rayleigh–Jeans tail; any blackbody, even a 600 K one bright on its Wien side,
    # bends the other way: the bands lie above the continuum, never below.
    star = index(lambda w: w**-2.0)

    assert all(abs(band["depth"]) < 0.005 for band in star["bands"])
    assert star["verdict"] == "none"
    for kelvin in (600, 3000, 5800):
        body = index(planck(kelvin))
        assert all(band["depth"] < 0 for band in body["bands"])
        assert body["sigma"] < 0


def test_too_few_channels_or_a_faint_continuum_give_no_index():
    continuum = [(w.lo_um, 10.0, 1.0, w.code) for w in fingerprint.WINDOWS for _ in "ab"]
    without_bands = [p for p in continuum if not any(b.holds(p[0]) for b in CH4)]
    faint = [(w, f if any(b.holds(w) for b in CH4) else f / 10, e, o) for w, f, e, o in continuum]

    lacking = fingerprint.methane_index(without_bands)
    dim = fingerprint.methane_index(faint)
    psf_missing = fingerprint.methane_index(continuum, total=False)

    assert (lacking.verdict, lacking.summary, lacking.sigma) == (
        "not_enough_channels",
        "CH₄ index: not enough channels",
        None,
    )
    assert {band.status for band in lacking.bands} == {"not_enough_channels"}
    assert (dim.verdict, dim.summary) == ("continuum_too_faint", "CH₄ index: continuum too faint")
    assert (psf_missing.verdict, psf_missing.bands) == ("no_total_flux", [])


def test_bands_sharing_a_continuum_are_not_counted_twice():
    # The 2.25 and 3.3 µm bands share both continuum windows: an error there moves both.
    def point(w, edge):
        flux = 8.0 if w.kind == "band" else 10.0
        return (edge, flux, 0.5 if w.kind == "band" else 3.0, w.code)

    points = [point(w, edge) for w in fingerprint.WINDOWS for edge in (w.lo_um, w.hi_um)]

    index = fingerprint.methane_index(points)

    sigmas = [band.sigma for band in index.bands]
    assert index.sigma < sum(sigmas) / math.sqrt(len(sigmas))


def test_an_absorption_resting_on_one_visit_is_named(monkeypatch, settings, tmp_path):
    # Three visits per window; one in the 3.3 µm band lies far below the rest (an artefact, say).
    visits = _visits(_windows(per_window=3))
    odd, low = next((obs, w) for obs, w in visits if fingerprint.CH4_3_3.holds(w))
    _sky(
        monkeypatch, settings, tmp_path, visits, lambda w: -4 * CONTINUUM if w == low else CONTINUUM
    )

    result = _run()

    assert result["methane"]["verdict"] == "absorption"
    warning = _checks(result)["FINGERPRINT_ONE_VISIT"]
    assert warning["affects"] == [f"obs:{odd.obs_id}"]
    assert warning["detail"].startswith(f"Without {odd.obs_id} it drops from ")


def test_the_budget_is_shared_between_windows_and_detectors():
    wavelengths = {
        d: np.linspace(lo + 0.01, hi - 0.01, 20).tolist() for d, (lo, hi) in RANGES.items()
    }
    visits = [obs for obs, _ in _visits(wavelengths, start=-80)]

    plan = fingerprint.plan(visits, [], DETECTOR, MARKS, [DISTANCE])

    chosen = [cutout.visit for cutout in plan.cutouts]
    assert len(chosen) == followup.MAX_CUTOUTS
    expected = {
        obs.obs_id: fingerprint.planned_wavelength(obs, unit(*_track(obs.mjd - T1)))
        for obs in visits
    }
    for window in fingerprint.WINDOWS:
        available = sum(window.holds(expected[obs.obs_id]) for obs in visits)
        picked = sum(window.holds(expected[obs.obs_id]) for obs in chosen)
        assert picked >= min(fingerprint.WINDOW_VISITS, available) > 0
    per_detector = [sum(obs.detector == d for obs in chosen) for d in RANGES]
    assert min(per_detector) >= 4
    checks = {check.code: check for check in plan.checks}
    assert checks["FINGERPRINT_PLANNED"].detail.startswith("48 of 120 visits whose position")
    assert plan.reasons["thinned"] == 72


def test_a_straight_line_position_holds_for_every_detector_at_its_time():
    # One exposure seen by D3 and D6 (one obs_id), the mark set on its D6 image, and a D1 visit.
    paired = [_visit(3, 2.1, 5, "exposure")[0], _visit(6, 4.6, 5, "exposure")[0]]
    other = _visit(1, 1.0, 7)[0]
    points = [[obs.mjd, *_track(obs.mjd - T1), 1.0] for obs in (paired[0], other)]

    plan = fingerprint.plan(
        [*paired, other],
        [["exposure", None, None]],
        DETECTOR,
        points=[*points, [T1 + 50, 61, 19, 1]],
    )

    measured = [(cutout.visit.obs_id, cutout.visit.detector) for cutout in plan.cutouts]
    assert measured == [("exposure", 3), (other.obs_id, 1)]
    assert plan.reasons == {"unmatched_prediction": 1}
    (not_covered,) = [check for check in plan.checks if check.code == "FOLLOWUP_NOT_COVERED"]
    assert not_covered.detail == (
        "1 visits left out: 1 marked (their pixels made the marks); "
        "1 predicted positions match no visit"
    )


def test_imprecise_positions_are_left_out_of_the_spectrum():
    # Marks two days apart extrapolated by months: good enough for a follow-up, not for a PSF fit.
    marks = [[61.2, 19.8, T1, 1.0], [61.19, 19.8, T1 + 2, 1.0]]
    near, far = _visit(3, 2.1, 1)[0], _visit(3, 2.1, 90)[0]

    plan = fingerprint.plan([near, far], [], DETECTOR, marks, [DISTANCE])

    assert [cutout.visit.obs_id for cutout in plan.cutouts] == [near.obs_id]
    (not_covered,) = [check for check in plan.checks if check.code == "FOLLOWUP_NOT_COVERED"]
    assert "wider than 6″" in not_covered.detail


def test_the_wavelength_is_planned_from_the_footprint_as_the_cutout_measures_it():
    # The fixture cutout lies at detector pixel (686, 1600) of a D6 image: its full image's
    # corners in IRSA's order make the s_region that IRSA lists for that image.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        sky = WCS(fits.getheader(CUTOUT, "IMAGE"))
    corners = [(0, 0), (2040, 0), (2040, 2040), (0, 2040)]
    region = [sky.pixel_to_world_values(x - 686, y - 1600) for x, y in corners]
    obs = Observation(
        obs_id="2025W34_1B_0164_2",
        detector=6,
        wavelength_min_um=RANGES[6][0],
        wavelength_max_um=RANGES[6][1],
        mjd=60905.85,
        date="2025-08-18T20:30:50Z",
        access_url="https://irsa.invalid/d6.fits",
        s_region="POLYGON ICRS " + " ".join(f"{float(a)} {float(b)}" for a, b in region),
    )

    for x, y in [(0, 0), (500, -1200), (-600, 300)]:
        ra, dec = (float(value) for value in sky.pixel_to_world_values(x, y))
        measured, _ = wavelength_at(CUTOUT, ra, dec)
        planned = fingerprint.planned_wavelength(obs, unit(ra, dec))
        assert planned == pytest.approx(measured, abs=0.015)


GRID = {
    "marks": [
        {"ra": "61.2", "dec": "19.8", "mjd": T1},
        {"ra": "61.14", "dec": "19.79", "mjd": T1 + 20},
    ],
    "d_min_au": 100,
    "d_max_au": 900,
    "steps": 5,
}
MARKED = [{"obs_id": "2025W19_1B_0116_1", "date": "2025-05-05T16:49:00Z"}]
BODY = {"ra": "61.2", "dec": "19.8", "detector": 6, "marked": MARKED, "grid": GRID}


class _Queue:
    count = 0
    enqueued: list = []

    def __init__(self, name, **_):
        self.name = name

    def enqueue(self, function, **options):
        self.enqueued.append((self.name, function, options))


def _no_job(*_, **__):
    raise NoSuchJobError()


def test_a_fingerprint_waits_on_the_slow_queue_at_one_distance(client, monkeypatch):
    monkeypatch.setattr(jobs, "Queue", _Queue)
    monkeypatch.setattr(jobs.Job, "fetch", _no_job)
    _Queue.enqueued = []

    first = client.post("/api/followup/fingerprint", json={**BODY, "distance_au": 300})
    followup_job = client.post("/api/followup", json=BODY)

    assert first.status_code == 200
    assert first.json()["status"] == "queued"
    assert first.json()["job_id"] != followup_job.json()["job_id"]
    name, function, options = _Queue.enqueued[0]
    assert (name, function) == (jobs.SLOW_QUEUE, fingerprint.build_fingerprint)
    kwargs = options["kwargs"]
    assert kwargs["distances"] == [300]
    assert kwargs["marks"][1] == pytest.approx([61.14, 19.79, T1 + 20, 1.5])
    assert (kwargs["detector"], kwargs["collections"]) == (6, ["spherex_dr1"])


@pytest.mark.parametrize(
    "change",
    [
        {},
        {"distance_au": 1000},
        {"distance_au": float("nan")},
        {"grid": None, "points": [{"mjd": T1 + 3, "ra": 61.2, "dec": 19.8, "radius_arcsec": 2}]}
        | {"distance_au": 300},
    ],
)
def test_invalid_fingerprints_are_rejected(client, change):
    body = {**BODY, **change}
    response = client.post(
        "/api/followup/fingerprint",
        content=json.dumps(body),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_finished_fingerprint_comes_from_the_job_result(client, monkeypatch):
    class _Finished:
        def get_status(self):
            return jobs.JobStatus.FINISHED

        def return_value(self):
            methane = {
                "verdict": "not_enough_channels",
                "summary": "CH₄ index: not enough channels",
            }
            return {
                "collection": "spherex_dr1",
                "ra": 1.0,
                "dec": 2.0,
                "detector": 6,
                "model": "m",
                "methane": methane,
            }

    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: _Finished())

    response = client.get("/api/followup/fingerprint/0123456789abcdef")

    assert response.json()["status"] == "finished"
    assert response.json()["fingerprint"]["points"] == []
    assert client.get("/api/followup/fingerprint/not-a-job").status_code == 404
