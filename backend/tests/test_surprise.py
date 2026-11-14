import json
import os
import random
import time
from pathlib import Path

import httpx
import pytest

from app import surprise
from app.archive import resolve_cache_path

# Real Gaia DR3 answer to surprise.QUERY (14 Nov 2026), trimmed to its first three stars.
FIXTURE = (Path(__file__).parent / "fixtures" / "gaia_fast_stars.csv").read_text()


class Answer:
    text = FIXTURE

    def raise_for_status(self):
        pass


@pytest.fixture
def gaia(monkeypatch):
    calls = []

    def post(url, data, timeout):
        calls.append(data["QUERY"])
        return Answer()

    monkeypatch.setattr(surprise.httpx, "post", post)
    return calls


def test_parses_every_star_with_its_motion_and_an_honest_reason():
    stars = surprise.parse_gaia_csv(FIXTURE)

    assert [s.name for s in stars] == [
        "Gaia DR3 1015570963037979264",
        "Gaia DR3 2285089319219646976",
        "Gaia DR3 2398975118715404672",
    ]
    third = stars[2]
    assert round(third.pm_mas_yr) == 1435
    assert round(third.g_mag, 1) == 11.5
    assert third.reason == (
        "A fast-moving nearby star: it moves 1.4″ per year – watch it shift between the visits"
    )
    assert "discover" not in third.reason.lower()
    assert third.proper_motion.source_id == "2398975118715404672"


def test_the_position_is_moved_back_to_j2000_like_a_resolved_name():
    star = surprise.parse_gaia_csv(FIXTURE)[2]

    # pmDec is -1434 mas/yr: 16 years before Gaia's epoch the star stood ~22.95″ further north.
    assert round((star.dec - star.proper_motion.dec) * 3600, 2) == 22.95


def test_broken_rows_are_skipped():
    header, *rows = FIXTURE.splitlines()

    assert len(surprise.parse_gaia_csv("\n".join([header, "1,abc", "2,,,,,,,,", *rows]))) == 3


def test_asks_gaia_once_then_answers_from_the_disk_cache(settings, gaia):
    first = surprise.pick(settings, random.Random(1))
    again = surprise.pick(settings, random.Random(1))

    assert len(gaia) == 1
    assert "pm > 1000" in gaia[0] and "BETWEEN 8 AND 14" in gaia[0]
    assert first == again
    assert first.name.startswith("Gaia DR3 ")


def test_a_list_older_than_24_hours_is_fetched_again(settings, gaia):
    path = surprise.cache_path(settings)
    path.parent.mkdir(parents=True)
    path.write_text(FIXTURE.splitlines()[0] + "\n")
    day_ago = time.time() - surprise.CACHE_MAX_AGE_S - 1
    os.utime(path, (day_ago, day_ago))

    assert len(surprise.candidates(settings)) == 3
    assert len(gaia) == 1
    assert path.read_text() == FIXTURE


def test_an_old_list_beats_an_example_when_gaia_is_down(settings):
    path = surprise.cache_path(settings)
    path.parent.mkdir(parents=True)
    path.write_text(FIXTURE)
    day_ago = time.time() - surprise.CACHE_MAX_AGE_S - 1
    os.utime(path, (day_ago, day_ago))

    assert surprise.pick(settings).name.startswith("Gaia DR3 ")


def test_a_failed_query_is_not_repeated_for_ten_minutes(settings, gaia, monkeypatch):
    def error(*_, **__):
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(surprise.httpx, "post", error)
    assert surprise.candidates(settings) == []
    monkeypatch.setattr(surprise.httpx, "post", lambda *a, **k: gaia.append(1) or Answer())

    assert surprise.candidates(settings) == []
    assert gaia == []
    assert len(surprise.candidates(settings, force=True)) == 3


def test_force_keeps_the_old_list_when_gaia_is_down(settings):
    path = surprise.cache_path(settings)
    path.parent.mkdir(parents=True)
    path.write_text(FIXTURE)

    assert len(surprise.candidates(settings, force=True)) == 3
    assert path.read_text() == FIXTURE


def test_a_fresh_but_empty_list_is_fetched_again(settings, gaia):
    path = surprise.cache_path(settings)
    path.parent.mkdir(parents=True)
    path.write_text(FIXTURE.splitlines()[0] + "\n")

    assert len(surprise.candidates(settings)) == 3
    assert len(gaia) == 1


def test_gaia_down_gives_an_example_target_with_coordinates(settings):
    picks = {surprise.pick(settings, random.Random(seed)).name for seed in range(30)}

    # Without a resolver cache only the examples with fixed coordinates are known.
    assert picks == {"Polaris", "WISE 0855", "Pluto · known dwarf planet (2026)"}
    assert not surprise.cache_path(settings).exists()
    example = surprise.pick(settings)
    assert example.reason == "Gaia is not reachable – showing an example instead"
    assert example.proper_motion is None and example.pm_mas_yr is None


def test_resolved_examples_join_once_their_name_is_cached(settings):
    cached = resolve_cache_path(settings.cache_dir, "Barnard's Star")
    cached.parent.mkdir(parents=True)
    cached.write_text(json.dumps({"name": "Barnard's Star", "ra": 269.452, "dec": 4.693}))

    barnard = next(e for e in surprise.examples(settings) if e.name == "Barnard's Star")

    assert (barnard.ra, barnard.dec) == (269.452, 4.693)


def test_api_answers_with_a_star(client, gaia):
    body = client.get("/api/surprise").json()

    assert set(body) == {"name", "ra", "dec", "proper_motion", "pm_mas_yr", "g_mag", "reason"}
    assert body["pm_mas_yr"] > 1000


def test_api_falls_back_to_an_example_when_gaia_fails(client, monkeypatch):
    def error(*_, **__):
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(surprise.httpx, "post", error)

    body = client.get("/api/surprise").json()

    assert set(body) == {"name", "ra", "dec", "reason"}
    assert body["reason"] == surprise.GAIA_DOWN
