import hashlib
import json
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from rq.exceptions import NoSuchJobError

from app import followup, jobs, tasks
from app.archive import ArchiveError, parse_sia_votable
from app.frames import SPHEREX_PIXEL_SCALE_ARCSEC
from app.models import Observation
from app.photometry import SKIP_EDGE
from app.tracks import predict, unit

T1 = 61000.0
FIELD = (61.2, 19.8)
# Two marks 20 days apart, precise enough to predict the object half a year away.
MARKS = [[61.2, 19.8, T1, 0.1], [61.14, 19.79, T1 + 20, 0.1]]
# Uniform in 1/d from 100 to 900 AU: the object sits at the fourth distance, 300 AU.
DISTANCES = (1 / np.linspace(1 / 100, 1 / 900, 5)).tolist()
TRUE = 3
FAR = (-190, -185, 175, 180)
NEAR = (3, 6, 25)
PSF_SIGMA_PX = 0.85
SIA_FIXTURE = Path(__file__).parent / "fixtures" / "sia_wise0855.xml"


def _visit(day: float, name: str = "visit", **changes) -> Observation:
    return Observation(
        obs_id=f"{name}{day:+g}",
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=T1 + day,
        date=f"day{day:+g}",
        access_url=f"https://irsa.invalid/{name}{day:+g}.fits",
        **changes,
    )


def _square(ra: float, dec: float, half_deg: float) -> str:
    """An s_region as IRSA writes it: a square around (ra, dec)."""
    dra = half_deg / np.cos(np.radians(dec))
    corners = [(ra - dra, dec - half_deg), (ra + dra, dec - half_deg)]
    corners += [(ra + dra, dec + half_deg), (ra - dra, dec + half_deg)]
    return "POLYGON ICRS " + " ".join(f"{a:.6f} {b:.6f}" for a, b in corners)


def _sky(monkeypatch, settings, tmp_path, visits, flux=0.0, **options):
    """Offline archive: each cutout is unit noise around its centre, plus a point source of `flux`
    (summed MJy/sr) where the 300 AU hypothesis puts the object at the visits in `present`.

    Searches away from the field find `elsewhere` (or get no answer when `silent`); cutouts of
    visits in `missing` fail, of visits in `broken` arrive as an error page; returns the searched
    positions and the files written.
    """
    elsewhere = options.get("elsewhere", [])
    everything = visits + elsewhere
    times = np.array([v.mjd for v in everything])
    ra, dec, _ = predict(np.array(MARKS), np.array([DISTANCES[TRUE]]), times)
    truth = {v.access_url: (ra[0, i], dec[0, i]) for i, v in enumerate(everything)}
    present = options.get("present", set(truth))
    searched, written = [], {}

    def search(at_ra, at_dec, settings, collections):
        searched.append((at_ra, at_dec))
        if (at_ra, at_dec) == FIELD:
            return visits, []
        if options.get("silent"):
            raise ArchiveError("SPHEREx archive (IRSA) is not reachable")
        return elsewhere, []

    def fetch(client, url, directory):
        base, query = url.split("?")
        if base in options.get("missing", ()):
            request = httpx.Request("GET", url)
            raise httpx.HTTPStatusError("gone", request=request, response=httpx.Response(404))
        params = dict(part.split("=") for part in query.split("&"))
        size = round(float(params["size"]) * 3600 / SPHEREX_PIXEL_SCALE_ARCSEC)
        wcs = WCS(naxis=2)
        wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        wcs.wcs.crval = [float(value) for value in params["center"].split(",")]
        wcs.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
        wcs.wcs.cdelt = np.array([-1.0, 1.0]) * SPHEREX_PIXEL_SCALE_ARCSEC / 3600
        seed = int(hashlib.sha256(url.encode()).hexdigest()[:8], 16)
        path = written[url] = tmp_path / f"{seed}.fits"
        if base in options.get("broken", ()):
            path.write_bytes(b"<html>Server busy</html>")
            return path
        image = np.random.default_rng(seed).normal(0.0, 1.0, (size, size))
        yy, xx = np.indices(image.shape)
        if base in present:
            x, y = wcs.world_to_pixel_values(*truth[base])
            spread = 2 * PSF_SIGMA_PX**2
            image += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / spread) / (np.pi * spread)
        # IRSA clips a cutout where the visit's image ends.
        width = size // 2 if base in options.get("clipped", ()) else size
        hdus = [
            fits.PrimaryHDU(),
            fits.ImageHDU(image[:, :width], wcs.to_header(), name="IMAGE"),
            fits.ImageHDU(np.ones((size, width)), name="VARIANCE"),
        ]
        if base in options.get("flagged", ()):
            hot = np.hypot(xx - (size - 1) / 2, yy - (size - 1) / 2) <= 3
            header = fits.Header({"MSKN0000": "HOT", "MSKM0000": 1})
            hdus.append(fits.ImageHDU(hot[:, :width].astype(np.int32), header, name="FLAGS"))
        fits.HDUList(hdus).writeto(path, overwrite=True)
        return path

    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "search_observations", search)
    monkeypatch.setattr(tasks, "fetch_cutout", fetch)
    return searched, written


def _run(**changes) -> dict:
    params = {"ra": FIELD[0], "dec": FIELD[1], "detector": 6, "marked": []}
    params |= {"marks": MARKS, "distances": DISTANCES}
    return tasks.build_followup(**(params | changes))


def _checks(result: dict) -> dict:
    return {check["code"]: check for check in result["checks"]}


def _measured(result: dict) -> set[str]:
    return {m["obs_id"] for h in result["hypotheses"] for m in h["measurements"]}


def test_the_distance_of_the_object_stacks_to_the_highest_snr(monkeypatch, settings, tmp_path):
    visits = [_visit(day) for day in (*FAR, *NEAR, 0, 20, 500)]
    _sky(monkeypatch, settings, tmp_path, visits, flux=16.0)

    result = _run()

    snr = [h["snr"] for h in result["hypotheses"]]
    assert [h["distance_au"] for h in result["hypotheses"]] == pytest.approx(DISTANCES)
    assert (result["best"], result["significant"], result["complete"]) == (TRUE, True, True)
    assert result["distance_determined"] is True
    assert snr[TRUE] > max(s for i, s in enumerate(snr) if i != TRUE) + 3
    true = result["hypotheses"][TRUE]
    assert true["visits"] == len(FAR) + len(NEAR)
    days = sorted((*FAR, *NEAR))
    assert [m["obs_id"] for m in true["measurements"]] == [f"visit{day:+g}" for day in days]
    first = true["measurements"][0]
    assert first["source_url"].startswith("https://irsa.invalid/visit-190.fits?center=")
    assert (first["date"], first["skipped"], first["flagged"]) == ("day-190", None, False)
    assert first["radius_arcsec"] < 5
    checks = _checks(result)
    assert checks["FOLLOWUP_NOT_COVERED"]["detail"] == (
        "3 visits left out: 2 marked (their pixels made the marks), 1 more than 400 days from "
        "the marks"
    )
    assert checks["FOLLOWUP_MODEL_ERROR"]["message"] == "Orbits up to e = 0.5 assumed"
    assert checks["FOLLOWUP_GRID_COARSE"]["severity"] == "warning"
    significance = checks["FOLLOWUP_SIGNIFICANCE"]
    assert significance["message"].startswith("Flux along the track at 300 AU")
    assert "the best of 5 independent hypotheses is inflated by chance: " in significance["detail"]
    assert "σ local ≈ " in significance["detail"]
    assert "distances reach S/N 5: visits close to the marks" in significance["detail"]
    assert "FOLLOWUP_GEOCENTRIC" in checks
    assert "FOLLOWUP_ONE_VISIT" not in checks


def test_noise_alone_gives_no_significant_maximum(monkeypatch, settings, tmp_path):
    _sky(monkeypatch, settings, tmp_path, [_visit(day) for day in (*FAR, *NEAR)])

    result = _run()

    assert result["significant"] is False
    assert max(h["snr"] for h in result["hypotheses"]) < followup.SIGNIFICANT_SNR
    significance = _checks(result)["FOLLOWUP_SIGNIFICANCE"]
    assert significance["message"].startswith("No significant flux along the track")


def test_flux_from_a_single_visit_is_named(monkeypatch, settings, tmp_path):
    visits = [_visit(day) for day in (*FAR, *NEAR)]
    _sky(monkeypatch, settings, tmp_path, visits, flux=200.0, present={visits[0].access_url})

    result = _run()

    assert (result["best"], result["significant"]) == (TRUE, True)
    assert _checks(result)["FOLLOWUP_ONE_VISIT"]["affects"] == ["obs:visit-190"]


def test_flagged_and_clipped_visits_are_left_out_and_said(monkeypatch, settings, tmp_path):
    visits = [_visit(day) for day in (*FAR, *NEAR)]
    urls = [v.access_url for v in visits]
    _sky(monkeypatch, settings, tmp_path, visits, 16.0, flagged=set(urls[1:]), clipped={urls[0]})

    result = _run()

    assert (result["best"], result["significant"]) == (None, False)
    checks = _checks(result)
    assert checks["FOLLOWUP_FEW_VISITS"]["severity"] == "error"
    assert checks["FOLLOWUP_FLAGGED"]["severity"] == "warning"
    assert checks["FOLLOWUP_EDGE"]["detail"].startswith(f"{len(DISTANCES)} predicted positions")
    measurements = [m for h in result["hypotheses"] for m in h["measurements"]]
    assert all(m["flagged"] or m["skipped"] == SKIP_EDGE for m in measurements)


def test_a_marked_stack_measures_none_of_its_exposures(monkeypatch, settings, tmp_path):
    stack = [_visit(k / 10, name="stack") for k in range(8)]
    others = [_visit(day) for day in (*FAR, *NEAR, 20)]
    _sky(monkeypatch, settings, tmp_path, stack + others, flux=16.0)
    # Mark A on the stack (its mean time), mark B on one exposure.
    marks = [[61.2, 19.8, T1 + 0.35, 0.1], MARKS[1]]
    marked = [["stack+0", T1, T1 + 0.7], ["visit+20", None, None]]
    times = np.array([v.mjd for v in stack + others])
    ra, dec, _ = predict(np.array(MARKS), np.array([DISTANCES[TRUE]]), times)
    points = [[t, ra[0, i], dec[0, i], 2.0] for i, t in enumerate(times)]

    by_distance = _run(marks=marks, marked=marked)
    by_line = _run(marks=None, distances=None, points=points, marked=marked)

    for result in (by_distance, by_line):
        assert not {obs_id for obs_id in _measured(result) if not obs_id.startswith("visit")}
        assert "visit+20" not in _measured(result)
        detail = _checks(result)["FOLLOWUP_NOT_COVERED"]["detail"]
        assert detail.startswith("9 visits left out: 9 marked (their pixels made the marks)")


def test_predictions_outside_the_image_are_searched_elsewhere(monkeypatch, settings, tmp_path):
    field = _square(*FIELD, 0.3)
    visits = [_visit(day, s_region=field) for day in (*FAR, *NEAR)]
    elsewhere = [_visit(day, name="far") for day in (-188, 177)]
    searched, _ = _sky(monkeypatch, settings, tmp_path, visits, 16.0, elsewhere=elsewhere)

    result = _run()

    assert 1 < len(searched) <= 1 + followup.MAX_SEARCHES
    assert {"far-188", "far+177"} <= _measured(result)
    for hypothesis in result["hypotheses"]:
        for m in hypothesis["measurements"]:
            if m["obs_id"].startswith("visit"):
                assert followup._inside(field, unit(m["ra"], m["dec"])[None])[0]
    checks = _checks(result)
    assert checks["FOLLOWUP_NOT_COVERED"]["detail"] == (
        "16 predictions left out: 16 outside the visit's image"
    )
    assert "found 2 more visits of this detector" in checks["FOLLOWUP_SEARCHED"]["detail"]


def test_visits_close_to_the_marks_leave_the_distance_open(monkeypatch, settings, tmp_path):
    _sky(monkeypatch, settings, tmp_path, [_visit(day) for day in NEAR], flux=16.0)

    result = _run()

    assert (result["significant"], result["distance_determined"]) == (True, False)
    checks = _checks(result)
    assert checks["FOLLOWUP_DISTANCE_UNDETERMINED"]["severity"] == "warning"
    significance = checks["FOLLOWUP_SIGNIFICANCE"]
    assert significance["message"].startswith("Flux along the track (S/N")
    assert "independent hypotheses" not in significance["detail"]


def test_missing_and_unreadable_cutouts_leave_the_result_incomplete(
    monkeypatch, settings, tmp_path
):
    visits = [_visit(day) for day in (*FAR, *NEAR)]
    lost, broken = visits[1].access_url, visits[2].access_url
    _, written = _sky(monkeypatch, settings, tmp_path, visits, missing={lost}, broken={broken})

    result = _run()

    assert result["complete"] is False
    checks = [c for c in result["checks"] if c["code"] == "CUTOUT_MISSING"]
    skipped = [m for h in result["hypotheses"] for m in h["measurements"] if m["skipped"]]
    assert len(checks) == len({m["source_url"] for m in skipped}) == len(DISTANCES) * 2
    assert {m["skipped"] for m in skipped} == {followup.MISSING, followup.UNREADABLE}
    assert "FOLLOWUP_SKIPPED" not in _checks(result)
    # The error page is gone from the cache, so the next request fetches it again.
    assert not any(path.exists() for url, path in written.items() if url.startswith(broken))


def test_independent_distances_are_counted_at_the_visit_that_separates_them(
    monkeypatch, settings, tmp_path
):
    _sky(monkeypatch, settings, tmp_path, [_visit(day) for day in (*FAR, *NEAR)])
    # Near distances reach only the visits close to the marks: their model error is too large far
    # away, where the farther distances lie thousands of arcseconds apart.
    grid = (1 / np.linspace(1 / 20, 1 / 900, 64)).tolist()

    result = _run(distances=grid)

    assert result["distance_determined"] is True
    checks = _checks(result)
    assert "FOLLOWUP_DISTANCE_UNDETERMINED" not in checks
    assert "the best of 12 independent hypotheses" in checks["FOLLOWUP_SIGNIFICANCE"]["detail"]
    assert "where the distance model can be off" in checks["FOLLOWUP_NOT_COVERED"]["detail"]
    measurements = [m for h in result["hypotheses"] for m in h["measurements"]]
    uncertain = [m for m in measurements if m["position_uncertain"]]
    assert uncertain and all(m["model_error_arcsec"] <= 25 for m in measurements)
    assert checks["FOLLOWUP_POSITION_UNCERTAIN"]["detail"].startswith(f"{len(uncertain)} ")


def test_pluto_eighteen_days_after_marks_half_a_year_apart_is_measured():
    # Pluto (IRSA MOST, as in test_tracks.py): marks on 24 April 2026 and 198 days earlier.
    marks = [[308.518887, -22.889271, 61155.23361, 1.5], [304.130502, -23.618356, 60957.00611, 1.5]]
    later = _visit(61172.95538 - T1)

    plan = followup.plan([later], [], marks, [35.49])

    (cutout,) = plan.cutouts
    ra, dec = float(plan.ra[0, 0]), float(plan.dec[0, 0])
    assert 3600 * followup._degrees(unit(ra, dec) @ unit(308.553863, -22.941318)) < 10
    assert plan.radius[0, 0] + plan.error[0, 0] <= followup.MAX_RADIUS_ARCSEC
    assert "FOLLOWUP_POSITION_UNCERTAIN" in {check.code for check in plan.checks}


def test_a_measurement_error_is_not_taken_for_a_bad_cutout(monkeypatch, settings, tmp_path):
    _, written = _sky(monkeypatch, settings, tmp_path, [_visit(day) for day in NEAR])

    def broken(path, ra, dec):
        raise ValueError("a bug, not the archive")

    monkeypatch.setattr(followup, "forced_photometry", broken)

    with pytest.raises(ValueError, match="a bug"):
        _run()
    assert all(path.exists() for path in written.values())


def test_a_silent_extra_search_is_said_and_retried(monkeypatch, settings, tmp_path):
    field = _square(*FIELD, 0.3)
    visits = [_visit(day, s_region=field) for day in (*FAR, *NEAR)]
    events, _ = _sky(monkeypatch, settings, tmp_path, visits, silent=True)
    monkeypatch.setattr(tasks, "_report", lambda done, total: events.append(("report", total)))

    result = _run()

    # Progress shows before the extra searches start.
    assert events[0] == FIELD and events[1][0] == "report" and events[2][0] != "report"
    assert result["complete"] is False
    searched = _checks(result)["FOLLOWUP_SEARCHED"]
    assert searched["severity"] == "warning"
    assert "got no answer from the archive" in searched["detail"]


def test_a_bright_source_keeps_a_finite_global_significance():
    assert followup._global_sigma(5.0, 64) == pytest.approx(4.13, abs=0.01)
    assert 59 < followup._global_sigma(60.0, 64) < 60


def test_irsa_footprints_hold_the_position_they_were_found_at():
    observations = parse_sia_votable(SIA_FIXTURE.read_bytes(), "spherex_dr1")
    here, away = unit(133.79513, -7.24515)[None], unit(133.79513, -2.0)[None]

    assert all(o.s_region and o.s_region.startswith("POLYGON") for o in observations)
    assert all(followup._inside(o.s_region, here)[0] for o in observations)
    assert not any(followup._inside(o.s_region, away)[0] for o in observations)
    assert "s_region" not in observations[0].model_dump()


def test_cutouts_stay_within_the_budget():
    distances = (1 / np.linspace(1 / 300, 1 / 2000, 5)).tolist()
    twenty = followup.plan([_visit(day) for day in range(170, 190)], [], MARKS, distances)
    sixty = followup.plan([_visit(day) for day in range(130, 190)], [], MARKS, distances)

    assert (len(twenty.cutouts), twenty.kept) == (40, [0, len(distances) - 1])
    assert (len(sixty.cutouts), sixty.kept) == (followup.MAX_CUTOUTS, [0, len(distances) - 1])
    (thinned,) = [c for c in sixty.checks if c.code == "FOLLOWUP_THINNED"]
    assert thinned.detail == (
        "At most 48 cutouts per job: 2 of 5 distances, evenly spread in 1/d (narrow "
        "d_min_au–d_max_au for a finer grid); 24 of 60 visits, spread over all epochs"
    )


def test_imprecise_marks_leave_distant_visits_to_the_eye():
    marks = [[61.2, 19.8, T1, 1.5], [61.14, 19.79, T1 + 2, 1.5]]
    visits = [_visit(1), _visit(1, collection="spherex_qr3"), _visit(180)]

    plan = followup.plan(visits, [], marks, DISTANCES)

    assert {cutout.visit.obs_id for cutout in plan.cutouts} == {"visit+1"}
    (not_covered,) = [c for c in plan.checks if c.code == "FOLLOWUP_NOT_COVERED"]
    assert not_covered.detail == (
        "1 visits left out: 1 listed again by another release (counted once); "
        "5 predictions left out: 5 with a 2σ search circle wider than 25″"
    )


def test_a_straight_line_is_measured_where_the_client_puts_it(monkeypatch, settings, tmp_path):
    visits = [_visit(day) for day in (-190, 3, 180, 400)]
    _sky(monkeypatch, settings, tmp_path, visits, flux=16.0)
    times = np.array([v.mjd for v in visits[:3]])
    ra, dec, _ = predict(np.array(MARKS), np.array([DISTANCES[TRUE]]), times)
    points = [[mjd, ra[0, i], dec[0, i], 2.0] for i, mjd in enumerate(times)]

    result = _run(marks=None, distances=None, points=[*points, [T1 + 50, 61.0, 19.0, 2.0]])

    (line,) = result["hypotheses"]
    assert (line["distance_au"], line["visits"], result["best"]) == (None, 3, 0)
    assert result["model"] == followup.STRAIGHT_LINE
    checks = _checks(result)
    assert checks["FOLLOWUP_NOT_COVERED"]["detail"] == (
        "1 visits left out: 1 without a predicted position; "
        "1 predicted positions match no visit of this detector"
    )
    assert "FOLLOWUP_GEOCENTRIC" not in checks
    assert "FOLLOWUP_DISTANCE_UNDETERMINED" not in checks


GRID = {
    "marks": [
        {"ra": "4h04m48s", "dec": "19.8", "mjd": T1},
        {"ra": "61.14", "dec": "19.79", "mjd": T1 + 20},
    ],
    "d_min_au": 100,
    "d_max_au": 900,
    "steps": 5,
}
POINT = {"mjd": T1 + 3, "ra": 61.2, "dec": 19.8, "radius_arcsec": 2.0}
MARKED = [
    {
        "obs_id": "2025W19_1B_0116_1",
        "date": "2025-05-05T16:49:00Z",
        "date_end": "2025-05-06T16:49:00Z",
    }
]
BODY = {"ra": "61.2", "dec": "19.8", "detector": 6, "marked": MARKED}


class _Queue:
    count = 0
    enqueued: list = []

    def __init__(self, name, **_):
        self.name = name

    def enqueue(self, function, **options):
        self.enqueued.append((self.name, function, options))


def _no_job(*_, **__):
    raise NoSuchJobError()


def test_followup_waits_on_the_slow_queue_with_parsed_marks(client, monkeypatch):
    monkeypatch.setattr(jobs, "Queue", _Queue)
    monkeypatch.setattr(jobs.Job, "fetch", _no_job)
    _Queue.enqueued = []

    first = client.post("/api/followup", json={**BODY, "grid": GRID})
    again = client.post("/api/followup", json={**BODY, "grid": GRID})

    assert first.status_code == 200
    assert first.json()["status"] == "queued"
    assert again.json()["job_id"] == first.json()["job_id"]
    name, function, options = _Queue.enqueued[0]
    assert (name, function) == (jobs.SLOW_QUEUE, tasks.build_followup)
    kwargs = options["kwargs"]
    assert kwargs["marks"][0] == pytest.approx([61.2, 19.8, T1, 1.5])
    assert kwargs["distances"] == pytest.approx(DISTANCES)
    (marked,) = kwargs["marked"]
    assert marked[0] == "2025W19_1B_0116_1"
    assert marked[1:] == pytest.approx([60800.700694, 60801.700694])
    assert (kwargs["detector"], kwargs["collections"]) == (6, ["spherex_dr1"])


@pytest.mark.parametrize(("complete", "rerun"), [(True, False), (False, True)])
def test_an_incomplete_followup_runs_again(client, monkeypatch, complete, rerun):
    class _Finished:
        deleted = False

        def get_status(self):
            return jobs.JobStatus.FINISHED

        def return_value(self):
            result = {"collection": "spherex_dr1", "ra": 1.0, "dec": 2.0, "detector": 6}
            return {**result, "model": "m", "complete": complete}

        def delete(self):
            self.deleted = True

    previous = _Finished()
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: previous)
    monkeypatch.setattr(jobs, "Queue", _Queue)
    _Queue.enqueued = []

    response = client.post("/api/followup", json={**BODY, "grid": GRID})

    assert response.json()["status"] == ("queued" if rerun else "finished")
    assert (len(_Queue.enqueued), previous.deleted) == (int(rerun), rerun)


@pytest.mark.parametrize(
    "change",
    [
        {},
        {"grid": GRID, "points": [POINT]},
        {"grid": GRID, "detector": 7},
        {"grid": GRID, "ra": "not an angle"},
        {"grid": GRID, "marked": []},
        {"grid": GRID, "marked": [{**MARKED[0], "date": "2025-05-05T16:49:00"}]},
        {"grid": {**GRID, "marks": [GRID["marks"][0], {**GRID["marks"][1], "mjd": T1 + 401}]}},
        {"points": []},
        {"points": [{**POINT, "ra": 360}]},
        {"points": [{**POINT, "radius_arcsec": float("nan")}]},
    ],
)
def test_invalid_followups_are_rejected(client, change):
    body = {**BODY, **change}
    # Raw text: Python's json writes NaN, which the API must reject.
    response = client.post(
        "/api/followup", content=json.dumps(body), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422


def test_finished_followup_comes_from_the_job_result(client, monkeypatch):
    class _Finished:
        def get_status(self):
            return jobs.JobStatus.FINISHED

        def return_value(self):
            return {"collection": "spherex_dr1", "ra": 1.0, "dec": 2.0, "detector": 6, "model": "m"}

    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: _Finished())

    response = client.get("/api/followup/0123456789abcdef")

    assert response.json()["status"] == "finished"
    assert response.json()["followup"]["hypotheses"] == []
    assert client.get("/api/followup/..").status_code == 404
