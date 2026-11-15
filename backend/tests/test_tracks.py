import json
import math
import time

import pytest

# Pluto from IRSA MOST (catalog=spherex obj_name=999:NID), queried 14 Nov 2026.
MARKS = [
    {"ra": "308.518887", "dec": "-22.889271", "mjd": 61155.23361},
    {"ra": "308.534245", "dec": "-22.894893", "mjd": 61157.94899},
]
EARLIER = (60957.00611, 304.130502, -23.618356)
LATER = (61172.95538, 308.553863, -22.941318)
PLUTO_AU = 35.49


def separation_arcsec(ra1, dec1, ra2, dec2):
    ra1, dec1, ra2, dec2 = map(math.radians, (ra1, dec1, ra2, dec2))
    cos = math.sin(dec1) * math.sin(dec2) + math.cos(dec1) * math.cos(dec2) * math.cos(ra1 - ra2)
    return math.degrees(math.acos(min(1.0, cos))) * 3600


def track(client, **body):
    payload = {"marks": MARKS, "target_mjds": [EARLIER[0], LATER[0]], **body}
    return client.post("/api/track/distant", json=payload)


def point_at(answer, distance_au, mjd):
    hypothesis = next(
        h for h in answer["hypotheses"] if h["distance_au"] == pytest.approx(distance_au)
    )
    return next(p for p in hypothesis["points"] if p["mjd"] == mjd)


def test_pluto_at_its_true_distance_lands_on_its_real_positions(client):
    response = track(client, d_min_au=PLUTO_AU, d_max_au=PLUTO_AU + 1, steps=2)
    assert response.status_code == 200
    answer = response.json()
    assert answer["model"] == "straight-line heliocentric motion + Earth parallax"
    assert all("orbit" not in a or "not an orbit" in a for a in answer["assumptions"])

    earlier = point_at(answer, PLUTO_AU, EARLIER[0])
    later = point_at(answer, PLUTO_AU, LATER[0])
    assert separation_arcsec(earlier["ra"], earlier["dec"], *EARLIER[1:]) < 120
    assert separation_arcsec(later["ra"], later["dec"], *LATER[1:]) < 10
    # Half a year from 2.7 days of motion: the search area is much wider than the marks' 1.5″.
    assert earlier["radius_arcsec"] > later["radius_arcsec"] > 3


def test_marks_half_a_year_apart_predict_a_third_visit(client):
    # Mark A in April 2026 (Pluto at 35.49 AU), mark B 198 days earlier, a third visit 18 days on.
    marks = [MARKS[0], {"ra": f"{EARLIER[1]}", "dec": f"{EARLIER[2]}", "mjd": EARLIER[0]}]
    body = {"marks": marks, "target_mjds": [LATER[0]], "d_min_au": 30, "d_max_au": PLUTO_AU}
    answer = client.post("/api/track/distant", json={**body, "steps": 2}).json()

    true, wrong = point_at(answer, PLUTO_AU, LATER[0]), point_at(answer, 30, LATER[0])
    miss = separation_arcsec(true["ra"], true["dec"], *LATER[1:])
    assert miss < 10
    assert separation_arcsec(wrong["ra"], wrong["dec"], *LATER[1:]) > 100
    # The search radius and the bound on the model's own error cover the remaining miss.
    assert miss <= true["radius_arcsec"] + true["model_error_arcsec"]
    assert true["model_error_arcsec"] < wrong["model_error_arcsec"]


def test_a_wrong_distance_misses_the_earlier_epoch(client):
    answer = track(client, d_min_au=30, d_max_au=31, steps=2).json()
    earlier = point_at(answer, 30, EARLIER[0])
    assert separation_arcsec(earlier["ra"], earlier["dec"], *EARLIER[1:]) > 1800


def test_default_grid_is_uniform_in_inverse_distance_and_fast(client):
    started = time.perf_counter()
    response = client.post(
        "/api/track/distant", json={"marks": MARKS, "target_mjds": [61155.0 + i for i in range(24)]}
    )
    elapsed = time.perf_counter() - started
    assert response.status_code == 200
    hypotheses = response.json()["hypotheses"]
    distances = [h["distance_au"] for h in hypotheses]
    assert len(distances) == 64
    assert distances[0] == pytest.approx(20)
    assert distances[-1] == pytest.approx(2000)
    inverse = [1 / d for d in distances]
    assert inverse[1] - inverse[0] == pytest.approx(inverse[-1] - inverse[-2])
    assert all(len(h["points"]) == 24 for h in hypotheses)
    assert elapsed < 0.2


def test_marks_across_ra_zero_give_a_track_across_ra_zero(client):
    marks = [
        {"ra": "359.9990", "dec": "1.0", "mjd": 61155.0},
        {"ra": "0.0010", "dec": "1.0", "mjd": 61156.0},
    ]
    answer = client.post(
        "/api/track/distant",
        json={"marks": marks, "target_mjds": [61155.5], "d_min_au": 50, "d_max_au": 60, "steps": 2},
    ).json()
    point = answer["hypotheses"][0]["points"][0]
    assert separation_arcsec(point["ra"], point["dec"], 0.0, 1.0) < 10
    assert point["radius_arcsec"] < 10


def test_sexagesimal_marks_are_parsed_like_degrees(client):
    marks = [
        {"ra": "20h34m04.53288s", "dec": "-22d53m21.3756s", "mjd": MARKS[0]["mjd"]},
        MARKS[1],
    ]
    body = {"target_mjds": [LATER[0]], "d_min_au": 30, "d_max_au": 40, "steps": 2}
    sexagesimal = client.post("/api/track/distant", json={"marks": marks, **body}).json()
    decimal = client.post("/api/track/distant", json={"marks": MARKS, **body}).json()
    a, b = sexagesimal["hypotheses"][0]["points"][0], decimal["hypotheses"][0]["points"][0]
    assert separation_arcsec(a["ra"], a["dec"], b["ra"], b["dec"]) < 0.1


@pytest.mark.parametrize(
    "change",
    [
        {"marks": MARKS[:1]},
        {"marks": [MARKS[0], {**MARKS[1], "ra": "not an angle"}]},
        {"marks": [MARKS[0], {**MARKS[1], "dec": "95"}]},
        {"marks": [MARKS[0], {**MARKS[1], "mjd": MARKS[0]["mjd"] + 401}]},
        {"marks": [MARKS[0], {**MARKS[1], "mjd": MARKS[0]["mjd"]}]},
        {"marks": [MARKS[0], {**MARKS[1], "sigma_arcsec": 31}]},
        {"target_mjds": []},
        {"target_mjds": [61155.0] * 25},
        {"target_mjds": [MARKS[0]["mjd"] - 401]},
        {"d_min_au": 4},
        {"d_min_au": 50, "d_max_au": 40},
        {"steps": 97},
        {"d_max_au": float("inf")},
        {"target_mjds": [float("nan")]},
        {"marks": [MARKS[0], {**MARKS[1], "sigma_arcsec": float("nan")}]},
    ],
)
def test_invalid_requests_are_rejected(client, change):
    body = {"marks": MARKS, "target_mjds": [LATER[0]], **change}
    # Raw text: Python's json writes NaN and Infinity, which the API must reject.
    response = client.post(
        "/api/track/distant", content=json.dumps(body), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
