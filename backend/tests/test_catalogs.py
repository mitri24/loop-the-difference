from pathlib import Path

import httpx
import pytest

from app import catalogs, main
from app.catalogs import find_proper_motion, gaia_cache_path, match_gaia_csv, position_at

# Real Gaia DR3 answer around Barnard's Star, trimmed to Barnard's Star and five neighbours.
FIXTURE = (Path(__file__).parent / "fixtures" / "gaia_barnard.csv").read_text()
# Real Gaia DR3 answer within 7″ of the M87 core: a proper motion, but no significant parallax.
M87 = (Path(__file__).parent / "fixtures" / "gaia_m87.csv").read_text()
BARNARD_J2000 = (269.452083, 4.693364)


def test_finds_barnards_star_by_moving_gaia_back_to_j2000():
    star = match_gaia_csv(FIXTURE, *BARNARD_J2000)

    assert star is not None
    assert star.source_id == "4472832130942575872"
    assert round(star.pmdec_mas_yr) == 10362
    assert round(star.parallax_mas) == 547
    assert star.ref_epoch == 2016.0


def test_barnards_star_moves_about_98_arcsec_north_from_gaia_epoch_to_mid_2025():
    star = match_gaia_csv(FIXTURE, *BARNARD_J2000)
    mjd_2025_5 = 51544.5 + 25.5 * 365.25

    ra, dec = position_at(star, mjd_2025_5)

    assert round((dec - star.dec) * 3600, 1) == 98.4
    assert ra < star.ra  # pmRA is negative: west


def test_no_star_at_the_position_means_no_match():
    assert match_gaia_csv(FIXTURE, 269.40, 4.60) is None
    assert (
        match_gaia_csv(
            "source_id,ra,dec,pmra,pmdec,parallax,parallax_over_error,ref_epoch\n", 0.0, 0.0
        )
        is None
    )


def test_a_galaxy_core_without_significant_parallax_gets_no_marker():
    assert match_gaia_csv(M87, 187.705931, 12.391123) is None


def test_broken_rows_are_skipped():
    header, *rows = FIXTURE.splitlines()
    broken = "\n".join([header, "1,abc,,,,,", *rows])

    assert match_gaia_csv(broken, *BARNARD_J2000) is not None


def test_a_short_row_is_skipped_instead_of_failing():
    header, *rows = FIXTURE.splitlines()

    assert match_gaia_csv("\n".join([header, "1,2", *rows]), *BARNARD_J2000) is not None


def test_resolve_answers_without_proper_motion_when_gaia_is_down(client, monkeypatch):
    monkeypatch.setattr(main, "resolve_position", lambda name, settings: (1.0, 2.0))

    response = client.get("/api/resolve", params={"name": "Somewhere"})

    assert response.status_code == 200
    assert "proper_motion" not in response.json()
    assert response.json()["ra"] == 1.0


class FakeGaia:
    """Answers like the Gaia TAP service until it is switched off."""

    def __init__(self, text):
        self.text, self.up, self.calls = text, True, 0

    def post(self, url, data, timeout):
        self.calls += 1
        if not self.up:
            raise httpx.ConnectTimeout("Gaia is down")
        return httpx.Response(200, text=self.text, request=httpx.Request("POST", url))


def test_a_cached_gaia_answer_survives_a_gaia_outage(monkeypatch, tmp_path):
    gaia = FakeGaia(FIXTURE)
    monkeypatch.setattr(catalogs.httpx, "post", gaia.post)

    first = find_proper_motion(*BARNARD_J2000, strict=True, cache_dir=tmp_path)
    gaia.up = False
    again = find_proper_motion(*BARNARD_J2000, strict=True, cache_dir=tmp_path)

    assert first is not None and again == first
    assert gaia.calls == 1
    assert gaia_cache_path(tmp_path, *BARNARD_J2000).is_file()


def test_no_star_is_cached_too_and_a_failure_is_not(monkeypatch, tmp_path):
    header = FIXTURE.splitlines()[0]
    gaia = FakeGaia(header)
    monkeypatch.setattr(catalogs.httpx, "post", gaia.post)
    assert find_proper_motion(10.0, 20.0, cache_dir=tmp_path) is None
    gaia.up = False
    assert find_proper_motion(10.0, 20.0, strict=True, cache_dir=tmp_path) is None

    with pytest.raises(httpx.HTTPError):
        find_proper_motion(30.0, 40.0, strict=True, cache_dir=tmp_path)
    assert not gaia_cache_path(tmp_path, 30.0, 40.0).exists()


def test_resolve_keeps_the_marker_from_the_cache_when_gaia_is_down(client, settings, monkeypatch):
    gaia = FakeGaia(FIXTURE)
    monkeypatch.setattr(catalogs.httpx, "post", gaia.post)
    monkeypatch.setattr(main, "resolve_position", lambda name, settings: BARNARD_J2000)
    warm = client.get("/api/resolve", params={"name": "Barnard's Star"}).json()
    gaia.up = False

    offline = client.get("/api/resolve", params={"name": "Barnard's Star"}).json()

    assert offline["proper_motion"] == warm["proper_motion"]
    assert offline["proper_motion"]["pmdec_mas_yr"] > 10000


def test_a_damaged_cache_file_or_an_error_page_is_asked_again_not_trusted(monkeypatch, tmp_path):
    path = gaia_cache_path(tmp_path, *BARNARD_J2000)
    path.parent.mkdir()
    path.write_text("")  # e.g. a disk that filled up
    gaia = FakeGaia("<html>Service busy</html>")
    monkeypatch.setattr(catalogs.httpx, "post", gaia.post)

    assert find_proper_motion(*BARNARD_J2000, cache_dir=tmp_path) is None
    assert gaia.calls == 1
    assert not path.exists()  # an error page is not stored as "no star"

    gaia.text = FIXTURE
    assert find_proper_motion(*BARNARD_J2000, cache_dir=tmp_path) is not None
    assert path.read_text() == FIXTURE


def test_the_match_rule_applies_to_cached_answers(monkeypatch, tmp_path):
    monkeypatch.setattr(catalogs.httpx, "post", FakeGaia(FIXTURE).post)
    assert find_proper_motion(*BARNARD_J2000, cache_dir=tmp_path) is not None
    monkeypatch.setattr(catalogs, "MIN_PARALLAX_OVER_ERROR", 1e9)

    assert find_proper_motion(*BARNARD_J2000, cache_dir=tmp_path) is None
