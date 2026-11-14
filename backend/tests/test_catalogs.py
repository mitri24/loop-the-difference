from pathlib import Path

from app import main
from app.catalogs import match_gaia_csv, position_at

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
