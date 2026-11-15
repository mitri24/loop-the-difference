import json
import math
from pathlib import Path

import httpx
import pytest

from app import jobs, smallbodies
from app.models import SmallBodiesJob, SmallBodyEpoch

FIXTURES = Path(__file__).parent / "fixtures"
# Real second pass for RA 03:00:00, Dec +17:00:00 at JD 2460989.75, geocentric (7 bodies).
ECLIPTIC = json.loads((FIXTURES / "sbident_ecliptic.json").read_text())
# Real second pass for WISE 0855−0714 on 2025-11-10: "no matching records".
EMPTY = json.loads((FIXTURES / "sbident_empty.json").read_text())
# Real JPL Horizons answers for SPHEREx at JD 2460989.75 and 2460990.75, and before launch.
HORIZONS = json.loads((FIXTURES / "horizons_spherex.json").read_text())
PRELAUNCH = json.loads((FIXTURES / "horizons_prelaunch.json").read_text())
# Real second pass for the ECLIPTIC field and time, seen from SPHEREx's position in HORIZONS.
SPHEREX = json.loads((FIXTURES / "sbident_spherex.json").read_text())
RA, DEC, MJD = 45.0, 17.0, 60989.25
SPHEREX_KM = (2559.544149614247, -1082.630573156565, 6444.069526239867)


def test_bodies_off_the_frame_are_dropped_and_the_brightest_comes_first():
    bodies = smallbodies.parse_sbident(ECLIPTIC, RA, DEC, 0.2)

    # 64030 lies 365″ east of the centre: inside the query box, outside the 0.2° frame.
    assert len(bodies) == 6
    assert "64030 (2001 SQ168)" not in [b.name for b in bodies]
    first = bodies[0]
    assert first.name == "298898 (2004 TR48)" and first.vmag == 19.3
    assert first.ra == pytest.approx(45.0412083, abs=1e-6)
    assert first.dec == pytest.approx(17.0698333, abs=1e-6)
    assert (first.ra_rate, first.dec_rate) == (-38.24, -6.519)
    # JPL's own distance from the centre is 288.7″.
    assert first.distance_arcsec == pytest.approx(288.7, abs=0.5)


def test_a_smaller_frame_keeps_only_the_bodies_on_it():
    names = [b.name for b in smallbodies.parse_sbident(ECLIPTIC, RA, DEC, 0.12)]

    assert names == ["(2016 GD49)"]


def test_an_empty_field_has_no_bodies():
    assert smallbodies.parse_sbident(EMPTY, 133.795, -7.245, 0.2) == []


def test_an_answer_without_rows_or_an_empty_field_statement_is_an_unknown_format():
    changed = {key: value for key, value in EMPTY.items() if key != "warning"}

    with pytest.raises(KeyError):
        smallbodies.parse_sbident(changed, 133.795, -7.245, 0.2)
    assert smallbodies.parse_sbident({**changed, "n_second_pass": 0}, 133.795, -7.245, 0.2) == []


def test_query_asks_the_second_pass_for_a_box_around_the_frame():
    params = smallbodies.query_params(133.79513, -7.24514, 0.2, 60989.25)

    assert params["obs-time"] == "2460989.75000"
    assert params["fov-ra-center"] == "08-55-10.83"
    assert params["fov-dec-center"] == "M07-14-42.5"
    assert (params["two-pass"], params["suppress-first-pass"]) == ("true", "true")
    assert params["mpc-code"] == "500"
    # RA half-width in coordinate degrees: wider than the 0.1° on the sky.
    assert float(params["fov-ra-hwidth"]) > float(params["fov-dec-hwidth"]) > 0.1


def test_job_id_depends_on_field_and_times_but_not_on_their_order():
    times = smallbodies.canonical_mjds([60990.5, 60989.25, 60990.500001])
    same = smallbodies.canonical_mjds([60989.25, 60990.5])

    assert times == same == [60989.25, 60990.5]
    job_id = smallbodies.job_id_for(RA, DEC, 0.2, times)
    assert job_id == smallbodies.job_id_for(RA, DEC, 0.2, same)
    assert job_id != smallbodies.job_id_for(RA, DEC, 0.2, [60989.25])
    assert job_id != smallbodies.job_id_for(RA, DEC, 0.3, times)


def test_horizons_gives_spherex_s_geocentric_position_at_each_epoch_time():
    params = smallbodies.horizons_params([MJD, 60990.25])
    positions = smallbodies.parse_horizons(HORIZONS)

    assert params["TLIST"] == "'60989.25000' '60990.25000'"
    assert (params["COMMAND"], params["CENTER"], params["REF_SYSTEM"], params["TIME_TYPE"]) == (
        "'-163182'",
        "'500@399'",
        "'ICRF'",
        "'UT'",
    )
    assert positions[MJD] == pytest.approx(SPHEREX_KM)
    # About 650 km above the surface.
    assert all(7000 < math.hypot(*km) < 7100 for km in positions.values())
    assert sorted(positions) == [MJD, 60990.25]
    with pytest.raises(ValueError, match="No ephemeris"):
        smallbodies.parse_horizons(PRELAUNCH)


def test_from_spherex_the_positions_shift_by_the_parallax_and_the_rates_stay_geocentric():
    params = smallbodies.query_params(RA, DEC, 0.2, MJD, SPHEREX_KM)

    assert params["xobs"] == SPHEREX["summary"]["xobs"] == "2559.544,-1082.631,6444.070,0,0,0"
    assert "mpc-code" not in params
    geocentric = {b.name: b for b in smallbodies.parse_sbident(ECLIPTIC, RA, DEC, 0.2)}
    seen = {b.name: b for b in smallbodies.parse_sbident(SPHEREX, RA, DEC, 0.2)}
    assert seen.keys() == geocentric.keys()
    shifts = [
        math.hypot((b.ra - g.ra) * math.cos(math.radians(g.dec)), b.dec - g.dec) * 3600
        for b, g in ((seen[name], geocentric[name]) for name in seen)
    ]
    # SPHEREx sat 6,400 km off the line of sight: 2–10″ for these main-belt asteroids.
    assert min(shifts) > 2 and max(shifts) < 10
    for name, body in seen.items():
        assert body.ra_rate == pytest.approx(geocentric[name].ra_rate, abs=0.01)
        assert body.dec_rate == pytest.approx(geocentric[name].dec_rate, abs=0.01)


class _Response:
    def __init__(self, payload, status=200):
        self.payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", smallbodies.SBIDENT_URL)
            raise httpx.HTTPStatusError("error", request=request, response=self)

    def json(self):
        return self.payload


def test_a_found_epoch_is_cached_and_served_without_asking_jpl_again(tmp_path, monkeypatch):
    calls = []

    def answer(url, params, timeout):
        calls.append(params["obs-time"])
        return _Response(ECLIPTIC)

    monkeypatch.setattr(smallbodies.httpx, "get", answer)
    first = smallbodies.epoch_bodies(RA, DEC, 0.2, MJD, tmp_path)
    second = smallbodies.epoch_bodies(RA, DEC, 0.2, MJD, tmp_path)

    assert calls == ["2460989.75000"]
    assert first == second and len(first.bodies) == 6 and first.error is None
    assert first.date == "2025-11-10T06:00:00Z"
    assert first.source_url.startswith(smallbodies.SBIDENT_URL + "?mpc-code=500")


def test_spherex_positions_are_cached_once_horizons_answered(tmp_path, monkeypatch):
    calls = []

    def answer(url, params, timeout):
        calls.append(url)
        return _Response(HORIZONS)

    monkeypatch.setattr(smallbodies.httpx, "get", answer)
    first = smallbodies.spherex_positions([MJD, 60990.25], tmp_path)
    second = smallbodies.spherex_positions([MJD, 60990.25], tmp_path)

    assert calls == [smallbodies.HORIZONS_URL]
    assert first == second and first[MJD] == pytest.approx(SPHEREX_KM)


@pytest.mark.parametrize(
    ("answer", "error"),
    [
        (httpx.ConnectError("down"), smallbodies.UNREACHABLE),
        (httpx.ReadTimeout("slow"), smallbodies.UNREACHABLE),
        (_Response({}, status=503), smallbodies.UNREACHABLE),
        (_Response({"message": "bad"}, status=400), "JPL SBIdent rejected the request (HTTP 400)"),
        (_Response({"fields_second": ["Object name"], "data_second_pass": [["x"]]}), None),
    ],
)
def test_a_failed_epoch_reports_the_reason_invents_nothing_and_is_not_cached(
    tmp_path, monkeypatch, answer, error
):
    def respond(*_, **__):
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(smallbodies.httpx, "get", respond)
    epoch = smallbodies.epoch_bodies(RA, DEC, 0.2, MJD, tmp_path)

    assert epoch.bodies == []
    assert epoch.error == (error or "JPL SBIdent answered in an unexpected format")
    assert not (tmp_path / "smallbodies").exists()


def _jpl(sbident, horizons):
    """httpx.get for Horizons (an answer, a response or an exception) and SBIdent (by params)."""

    def answer(url, params, timeout):
        if url != smallbodies.HORIZONS_URL:
            return sbident(params)
        if isinstance(horizons, Exception):
            raise horizons
        return horizons if isinstance(horizons, _Response) else _Response(horizons)

    return answer


def _job(tmp_path, monkeypatch, sbident, horizons, mjds):
    monkeypatch.setattr(smallbodies.httpx, "get", _jpl(sbident, horizons))
    monkeypatch.setattr(smallbodies, "get_settings", lambda: type("S", (), {"cache_dir": tmp_path}))
    result = smallbodies.find_small_bodies(RA, DEC, 0.2, mjds)
    return [SmallBodyEpoch.model_validate(e) for e in result["epochs"]]


def test_the_job_answers_every_epoch_in_time_order_seen_from_spherex(tmp_path, monkeypatch):
    def sbident(params):
        if params["obs-time"].startswith("2460990"):
            raise httpx.ConnectError("down")
        return _Response(SPHEREX)

    epochs = _job(tmp_path, monkeypatch, sbident, HORIZONS, [MJD, 60990.25])

    assert [e.mjd for e in epochs] == [MJD, 60990.25]
    assert len(epochs[0].bodies) == 6 and epochs[0].error is None
    assert "?xobs=2559.544%2C-1082.631%2C6444.070%2C0%2C0%2C0&" in epochs[0].source_url
    assert epochs[1].bodies == [] and epochs[1].error == smallbodies.UNREACHABLE


@pytest.mark.parametrize(
    ("horizons", "cached"),
    [
        (httpx.ConnectError("down"), 1),
        (_Response({}, status=503), 1),
        (PRELAUNCH, 1),
        ({"signature": {"version": "1.2"}, "result": "no table"}, 1),
        # Horizons answered, but not for this time: its answer is kept like any other.
        ({**HORIZONS, "result": HORIZONS["result"].replace("2460989.75", "2460989.70")}, 2),
    ],
)
def test_without_a_spherex_position_an_epoch_is_looked_up_for_the_geocentre(
    tmp_path, monkeypatch, horizons, cached
):
    [epoch] = _job(tmp_path, monkeypatch, lambda _: _Response(ECLIPTIC), horizons, [MJD])

    assert epoch.source_url.startswith(smallbodies.SBIDENT_URL + "?mpc-code=500&")
    assert len(epoch.bodies) == 6 and epoch.error is None
    # A failed Horizons request is not cached: the next lookup asks again.
    assert len(list((tmp_path / "smallbodies").iterdir())) == cached


def test_the_endpoint_validates_coordinates_times_and_job_ids(client):
    body = {"ra": "45", "dec": "17", "mjds": [MJD]}

    assert client.post("/api/smallbodies", json={**body, "ra": "abc"}).status_code == 422
    assert client.post("/api/smallbodies", json={**body, "mjds": []}).status_code == 422
    assert client.post("/api/smallbodies", json={**body, "mjds": [MJD] * 7}).status_code == 422
    assert client.post("/api/smallbodies", json={**body, "mjds": [1.0]}).status_code == 422
    assert client.post("/api/smallbodies", json={**body, "size_deg": 2}).status_code == 422
    assert client.get("/api/smallbodies/not-a-job").status_code == 404


def _epoch(error=None, geocentric=False):
    observer = "mpc-code=500" if geocentric else "xobs=2559.544%2C-1082.631%2C6444.070%2C0%2C0%2C0"
    url = f"{smallbodies.SBIDENT_URL}?{observer}&obs-time=2460989.75000"
    return SmallBodyEpoch(mjd=MJD, date="2025-11-10T06:00:00Z", error=error, source_url=url)


@pytest.mark.parametrize(
    ("previous", "rerun"),
    [
        (SmallBodiesJob(job_id="x", status="finished", epochs=[_epoch()]), False),
        (SmallBodiesJob(job_id="x", status="started"), False),
        (SmallBodiesJob(job_id="x", status="finished", epochs=[_epoch("down")]), True),
        (SmallBodiesJob(job_id="x", status="finished", epochs=[_epoch(geocentric=True)]), True),
        (SmallBodiesJob(job_id="x", status="not_found"), True),
    ],
)
def test_a_finished_lookup_is_reused_unless_an_epoch_failed_or_was_geocentric(
    client, monkeypatch, previous, rerun
):
    enqueued = []

    class _Queue:
        count = 0

        def __init__(self, name, connection):
            assert name == jobs.SLOW_QUEUE

        def enqueue(self, *_, **kwargs):
            enqueued.append(kwargs["kwargs"])

    monkeypatch.setattr(smallbodies, "status", lambda *_: previous)
    monkeypatch.setattr(smallbodies, "Queue", _Queue)
    monkeypatch.setattr(smallbodies.Job, "fetch", lambda *_, **__: _epoch_job())

    response = client.post(
        "/api/smallbodies", json={"ra": "03:00:00", "dec": "+17:00:00", "mjds": [MJD, MJD]}
    )

    assert response.status_code == 200
    expected = {"ra": 45.0, "dec": 17.0, "size_deg": 0.2, "mjds": [MJD]}
    assert enqueued == ([expected] if rerun else [])


def _epoch_job():
    class _Job:
        def delete(self):
            pass

    return _Job()
