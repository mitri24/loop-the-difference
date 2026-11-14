import os
import threading
import time
from pathlib import Path

import httpx
import pytest

from app import partners
from app.archive import ArchiveError

FIXTURES = Path(__file__).parent / "fixtures"
# Real CADC TAP answers for the query in partners.fetch_neossat (14 Nov 2026).
BARNARD = (FIXTURES / "cadc_neossat_barnard.csv").read_text()
WISE0855 = (FIXTURES / "cadc_neossat_wise0855.csv").read_text()
AT_BARNARD = {"ra": "269.452", "dec": "4.693"}


def cadc_answer(text: str, queries: list[str], status: int = 200):
    def post(url, data, timeout, follow_redirects):
        queries.append(data["QUERY"])
        return httpx.Response(status, text=text, request=httpx.Request("POST", url))

    return post


def test_counts_neossat_sky_frames_from_a_real_cadc_answer(client, monkeypatch):
    queries: list[str] = []
    monkeypatch.setattr(partners.httpx, "post", cadc_answer(BARNARD, queries))

    response = client.get("/api/partners/neossat", params=AT_BARNARD)

    assert response.status_code == 200
    body = response.json()
    assert body["collection"] == "NEOSSAT"
    assert body["count"] == 619
    assert body["first_date"] == "2019-10-13"
    assert body["last_date"] == "2019-12-03"
    assert body["search_url"] == (
        "https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/?Observation.collection=NEOSSAT"
        "&Observation.type=object&Plane.position.bounds=269.45200%204.69300#resultTableTab"
    )
    assert "not comparable with SPHEREx" in body["note"]
    assert "o.type = 'object'" in queries[0]
    assert "CIRCLE('ICRS', 269.452, 4.693, 0.001)" in queries[0]


def test_only_dark_frames_at_the_position_count_as_none(client, monkeypatch):
    monkeypatch.setattr(partners.httpx, "post", cadc_answer(WISE0855, []))

    response = client.get(
        "/api/partners/neossat", params={"ra": "08h55m10.831s", "dec": "-7d14m42.53s"}
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["count"], body["first_date"], body["last_date"]) == (0, None, None)


def test_answer_is_cached_on_disk_for_a_day(client, monkeypatch, settings):
    queries: list[str] = []
    monkeypatch.setattr(partners.httpx, "post", cadc_answer(BARNARD, queries))

    client.get("/api/partners/neossat", params=AT_BARNARD)
    client.get("/api/partners/neossat", params=AT_BARNARD)
    assert len(queries) == 1

    day_ago = time.time() - partners.CACHE_MAX_AGE_S - 1
    os.utime(partners.neossat_cache_path(settings.cache_dir, 269.452, 4.693), (day_ago, day_ago))
    assert client.get("/api/partners/neossat", params=AT_BARNARD).json()["count"] == 619
    assert len(queries) == 2


@pytest.mark.parametrize("status", [503, 400])
def test_cadc_error_is_a_bad_gateway_and_is_not_cached(client, monkeypatch, settings, status):
    monkeypatch.setattr(partners.httpx, "post", cadc_answer("busy", [], status=status))

    response = client.get("/api/partners/neossat", params=AT_BARNARD)

    assert response.status_code == 502
    assert response.json()["detail"] == "NEOSSat archive (CADC) is not reachable"
    assert not partners.neossat_cache_path(settings.cache_dir, 269.452, 4.693).exists()


def test_cadc_down_is_a_bad_gateway(client, monkeypatch):
    def down(*_, **__):
        raise httpx.ConnectError("CADC is down")

    monkeypatch.setattr(partners.httpx, "post", down)

    response = client.get("/api/partners/neossat", params=AT_BARNARD)

    assert response.status_code == 502
    assert response.json()["detail"] == "NEOSSat archive (CADC) is not reachable"


def test_unexpected_answer_is_an_archive_error():
    with pytest.raises(ArchiveError, match="Unexpected answer"):
        partners.parse_neossat_csv("<html>maintenance</html>", 269.452, 4.693)
    with pytest.raises(ArchiveError, match="Unexpected answer"):
        partners.parse_neossat_csv("", 269.452, 4.693)


def test_slow_cadc_times_out_and_the_late_answer_fills_the_cache(client, monkeypatch, settings):
    release = threading.Event()
    queries: list[str] = []

    def slow(url, data, timeout, follow_redirects):
        queries.append(data["QUERY"])
        release.wait(5)
        return httpx.Response(200, text=BARNARD, request=httpx.Request("POST", url))

    monkeypatch.setattr(partners.httpx, "post", slow)
    monkeypatch.setattr(partners, "LOOKUP_TIMEOUT_S", 0.05)

    first = client.get("/api/partners/neossat", params=AT_BARNARD)
    retry = client.get("/api/partners/neossat", params=AT_BARNARD)

    assert (first.status_code, retry.status_code) == (504, 504)
    assert first.json()["detail"] == "NEOSSat archive (CADC) is slow – try again in a minute"
    # The retry waited for the query that was still running instead of sending a second one.
    assert len(queries) == 1
    path = partners.neossat_cache_path(settings.cache_dir, 269.452, 4.693)
    late = partners._pending[path]
    release.set()
    late.result(timeout=5)
    assert client.get("/api/partners/neossat", params=AT_BARNARD).json()["count"] == 619
    assert len(queries) == 1


def test_invalid_coordinates_never_reach_cadc(client, monkeypatch):
    queries: list[str] = []
    monkeypatch.setattr(partners.httpx, "post", cadc_answer(BARNARD, queries))

    response = client.get("/api/partners/neossat", params={"ra": "0", "dec": "95"})

    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid declination"
    assert queries == []
