"""Parsers for external services, on recorded real responses (no network)."""

import itertools
import json
from pathlib import Path

import httpx
import pytest

from app import catalogs
from app.astrometry import angular_sep_arcsec, propagate

DATA = Path(__file__).parent / "data"
# IRSA Gator answers to the code's own requests, 15 Nov 2026: CatWISE2020 within 36″ of WISE
# 0855−0714's 2015 position, AllWISE within 30″ of Barnard's Star in 2010.5.
CATWISE = (DATA / "catwise_wise0855_sample.xml").read_bytes()
ALLWISE = (DATA / "allwise_barnard_sample.xml").read_bytes()
# Gator's answer for a catalogue it does not know: a VOTable without a table.
NO_TABLE = b"""<?xml version="1.0"?>
<VOTABLE version="1.3" xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE type="results">
<INFO name="QUERY_STATUS" value="ERROR">The catalog is not on the list.</INFO>
</RESOURCE></VOTABLE>"""


HORIZONS = json.loads((DATA / "horizons_spherex.json").read_text())
SBIDENT = json.loads((DATA / "sbident_sample.json").read_text())


def _jpl(horizons: httpx.Response, asked: list[httpx.Request]):
    """JPL's two services: Horizons for SPHEREx's position, then SBIdent."""

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return (
            horizons
            if request.url.host == "ssd.jpl.nasa.gov"
            else httpx.Response(200, json=SBIDENT)
        )

    return handler


@pytest.mark.asyncio
async def test_sbident_parsing_on_recorded_response():
    asked: list[httpx.Request] = []
    catalogs._SB_CACHE.clear()
    catalogs._SPHEREX_AT.clear()
    # Horizons down: SBIdent looks from the geocentre.
    transport = httpx.MockTransport(_jpl(httpx.Response(503), asked))
    async with httpx.AsyncClient(transport=transport) as client:
        observer, objs = await catalogs.sbident_field(120.0, 20.0, 0.2, 61055.0, client)
    sbident = asked[-1].url.params
    assert observer == "geocentre"
    assert (sbident["mpc-code"], sbident["fov-ra-center"]) == ("500", "08-00-00.00")
    assert "xobs" not in sbident
    assert {o.observer for o in objs} == {"geocentre"}
    assert len(objs) == 3
    first = objs[0]
    assert first.name == "39467 (1978 RA7)"
    assert first.ra == pytest.approx(15 * (7 + 59 / 60 + 17.91 / 3600))
    assert first.dec == pytest.approx(19 + 57 / 60 + 35.6 / 3600)
    assert first.vmag == pytest.approx(19.4)
    assert first.ra_rate_arcsec_h == pytest.approx(-38.79)


def test_sexagesimal_helpers():
    assert catalogs._sexa_ra(120.0) == "08-00-00.00"
    assert catalogs._sexa_dec(-7.245147) == "-07-14-42.5"
    assert catalogs._parse_dec_dms("-07 14'42.5\"") == pytest.approx(-7.245139, abs=1e-5)


def _irsa(answers):
    """IRSA Gator: the recorded answer, or an HTTP error status, per catalogue."""

    def handler(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        assert (params["spatial"], params["outfmt"], params["outrows"]) == ("cone", "3", "10000")
        assert {"ra", "dec", "w1mpro", "pmra", "sigpmdec"} <= set(params["selcols"].split(","))
        answer = answers[params["catalog"]]
        if isinstance(answer, int):
            return httpx.Response(answer, text="Proxy Error")
        return httpx.Response(200, content=answer)

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_catwise_positions_lie_at_their_mean_epoch_and_motions_bring_them_together():
    catalogs._CATALOG_CACHE.clear()
    async with httpx.AsyncClient(transport=_irsa({"catwise_2020": CATWISE})) as client:
        sources, checks = await catalogs.wise_cone(133.786, -7.2453, 0.01, client)

    assert checks == [] and len(sources) == 21
    still = next(s for s in sources if s.id == "CatWISE2020 J085509.47-071502.9")
    assert still.pm_ra_mas_yr is None and still.mag == pytest.approx(14.999)  # motion < 1σ
    fragments = [s for s in sources if (s.pm_ra_mas_yr or 0) < -7000]
    assert [round(s.epoch_jyear, 2) for s in fragments] == [2015.22, 2015.86, 2017.27]
    assert fragments[0].pm_dec_mas_yr == pytest.approx(806.2)
    # The three fragments of WISE 0855−0714 meet in 2025 (21″ apart if dated MJD 57170).
    at_2025 = [
        propagate(s.ra, s.dec, s.pm_ra_mas_yr, s.pm_dec_mas_yr, s.epoch_jyear, 2025.34)
        for s in fragments
    ]
    assert max(angular_sep_arcsec(*p, *q) for p, q in itertools.combinations(at_2025, 2)) < 6


@pytest.mark.parametrize(
    ("catwise", "reason"),
    [(502, "HTTPStatusError"), (NO_TABLE, "ValueError"), (b"<html>busy</html>", "ValueError")],
)
@pytest.mark.asyncio
async def test_without_catwise_allwise_is_used_with_a_warning_and_without_both_it_raises(
    catwise, reason
):
    catalogs._CATALOG_CACHE.clear()
    answers = {"catwise_2020": catwise, "allwise_p3as_psd": ALLWISE}
    async with httpx.AsyncClient(transport=_irsa(answers)) as client:
        sources, checks = await catalogs.wise_cone(269.4519, 4.7236, 30 / 3600, client)
        # Barnard's Star; AllWISE's 2010 motion is significant (and 3.3″/yr off Gaia's in Dec).
        [barnard] = sources
        assert barnard.id == "AllWISE J175747.94+044323.8" and barnard.pm_dec_mas_yr == 13703
        assert [(c.code, c.severity) for c in checks] == [("catwise_unavailable", "warn")]
        assert reason in checks[0].detail
        catalogs._CATALOG_CACHE.clear()
        answers["allwise_p3as_psd"] = 502
        with pytest.raises(httpx.HTTPStatusError):
            await catalogs.wise_cone(269.4519, 4.7236, 30 / 3600, client)


# ---------------------------------------------------------------- CADC (Canada)
def test_cadc_parsing_and_grouping_on_recorded_response():
    """Real CADC CAOM-2 TAP answer around Barnard's Star (12 rows per collection)."""
    from datetime import UTC, datetime

    text = (DATA / "cadc_barnard_sample.csv").read_text()
    images, n_rows = catalogs.parse_cadc_rows(text, now=datetime(2026, 11, 13, tzinfo=UTC))
    assert n_rows == len(text.strip().splitlines()) - 1
    assert len({i.files_url for i in images}) == len(images)  # one entry per plane
    groups = catalogs.group_cadc(images)
    names = [g.collection for g in groups]
    assert names[0] == "NEOSSAT"  # Canadian Space Agency first
    assert names.index("CFHT") < names.index("HST")  # Canadian facilities before others
    neo = groups[0]
    assert neo.canadian and "Canadian Space Agency" in neo.label
    assert neo.images and all(i.thumbnail_url for i in neo.images)
    assert neo.images[0].thumbnail_url.startswith(
        "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/raven/files/cadc:NEOSSAT/"
    )
    assert neo.first_date.startswith("2019-")
    mjds = [i.mjd for i in neo.images]
    assert mjds == sorted(mjds, reverse=True)  # most recent first
    hst_thumbs = [i.thumbnail_url for g in groups if g.collection == "HST" for i in g.images]
    assert any(u and u.startswith("https://mast.stsci.edu/") for u in hst_thumbs)
    assert all(not i.proprietary for i in images)
    for q in (
        catalogs.cadc_query(269.45, 4.69, 0.05),
        catalogs.cadc_counts_query(269.45, 4.69, 0.05),
    ):
        assert "position_bounds_size >= 0.005" in q and "NOT IN ('TESS')" in q
        assert "o.intent = 'science'" in q


def test_cadc_embargoed_images_get_no_preview():
    """Future release date, null release (CAOM: not public) or garbage → embargoed."""
    from datetime import UTC, datetime

    header = (DATA / "cadc_barnard_sample.csv").read_text().splitlines()[0]
    rows = [
        f"NEOSSAT,X{i},NEOSSat,T,ivo://cadc.nrc.ca/NEOSSAT?X{i}/raw,60000.0,1.0,CLEAR,1,"
        f"{rel},cadc:NEOSSAT/X{i}_prev_256.png"
        for i, rel in enumerate(
            ["2030-01-01T00:00:00.000", "", "not-a-date", "2020-01-01T00:00:00"]
        )
    ]
    images, _ = catalogs.parse_cadc_rows(
        "\n".join([header, *rows]) + "\n", now=datetime(2026, 1, 1, tzinfo=UTC)
    )
    assert [i.proprietary for i in images] == [True, True, True, False]
    assert [i.thumbnail_url is None for i in images] == [True, True, True, False]


def test_cadc_nan_dates_are_dropped():
    header = (DATA / "cadc_barnard_sample.csv").read_text().splitlines()[0]
    row = "IRIS,I1,IRAS,T,ivo://cadc.nrc.ca/IRIS?I1/a,NaN,,100um,2,2001-01-01T00:00:00,"
    [img], _ = catalogs.parse_cadc_rows(f"{header}\n{row}\n")
    assert img.mjd is None and img.date_utc is None


def test_cadc_counts_override_a_truncated_listing():
    text = (DATA / "cadc_barnard_sample.csv").read_text()
    images, _ = catalogs.parse_cadc_rows(text)
    counts = catalogs.parse_cadc_counts(
        "collection,n,t0,t1\nNEOSSAT,571,58769.06,58820.06\nSDSS,45,52873.1,53846.4\nJCMT,7,,\n"
    )
    groups = {g.collection: g for g in catalogs.group_cadc(images, counts)}
    neo = groups["NEOSSAT"]
    assert neo.n_images == 571 and neo.last_date.startswith("2019-12-03")
    assert groups["JCMT"].n_images == 7 and groups["JCMT"].images == []  # counted, not listed


def test_cadc_motion_check_uses_the_oldest_listed_image():
    from app.schemas import CadcCollection

    def coll(name, first):
        return CadcCollection(
            collection=name,
            label=name,
            canadian=False,
            n_images=1,
            first_date=first,
            last_date=first,
            bands=[],
            instruments=[],
            images=[],
        )

    colls = [coll("NEOSSAT", "2019-10-20T00:00:00Z"), coll("HST", "1996-11-02T00:00:00Z")]
    assert catalogs.cadc_motion_check(0.4, 2026.9, colls) is None  # below threshold
    c = catalogs.cadc_motion_check(10.39, 2026.9, colls)
    assert c.code == "cadc_proper_motion" and "1996, HST" in c.detail
    assert f"{10.39 * (2026.9 - 1996) / 60:.1f}′" in c.detail  # 5.4′


@pytest.mark.asyncio
async def test_cadc_service_failure_is_a_warning_not_an_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    catalogs._CADC_CACHE.clear()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        res = await catalogs.cadc_images(10.0, 20.0, 0.05, client)
    assert res.collections == [] and res.checks[0].code == "cadc_unavailable"
    assert "TESS" in res.excluded_collections


@pytest.mark.asyncio
async def test_sbident_looks_from_spherex_where_horizons_gives_its_position():
    asked: list[httpx.Request] = []
    catalogs._SB_CACHE.clear()
    catalogs._SPHEREX_AT.clear()
    transport = httpx.MockTransport(_jpl(httpx.Response(200, json=HORIZONS), asked))
    async with httpx.AsyncClient(transport=transport) as client:
        observer, objs = await catalogs.sbident_field(120.0, 20.0, 0.2, 60989.25, client)
        again = await catalogs.sbident_field(120.0, 20.0, 0.2, 60989.25, client)
    horizons, sbident = (r.url.params for r in asked)
    assert (horizons["COMMAND"], horizons["CENTER"], horizons["TLIST"]) == (
        "'-163182'",
        "'500@399'",
        "'60989.25000'",
    )
    # The recorded geocentric position of SPHEREx at 2025-11-10 06:00 UTC, velocity zero.
    assert sbident["xobs"] == "2559.544,-1082.631,6444.070,0,0,0"
    assert "mpc-code" not in sbident
    assert observer == "SPHEREx" and {o.observer for o in objs} == {"SPHEREx"}
    assert again == (observer, objs) and len(asked) == 2


@pytest.mark.asyncio
async def test_spherex_position_is_none_before_launch_or_without_an_answer():
    catalogs._SPHEREX_AT.clear()
    error = {"error": 'No ephemeris for target "SPHEREx (spacecraft)" prior to A.D. 2025-MAR-12'}
    for answer in (
        httpx.Response(200, json=error),
        httpx.Response(502),
        httpx.Response(200, text="<html>"),
    ):
        transport = httpx.MockTransport(lambda request, answer=answer: answer)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await catalogs.spherex_position(60000.0, client) is None
    assert catalogs._SPHEREX_AT == {}


@pytest.mark.asyncio
async def test_a_field_looked_up_from_the_geocentre_is_asked_again_once_horizons_answers():
    asked: list[httpx.Request] = []
    catalogs._SB_CACHE.clear()
    catalogs._SPHEREX_AT.clear()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_jpl(httpx.Response(503), asked))
    ) as client:
        first, _ = await catalogs.sbident_field(120.0, 20.0, 0.2, 60989.25, client)
    answering = httpx.MockTransport(_jpl(httpx.Response(200, json=HORIZONS), asked))
    async with httpx.AsyncClient(transport=answering) as client:
        second, objs = await catalogs.sbident_field(120.0, 20.0, 0.2, 60989.25, client)
    sbident = [r.url.params for r in asked if r.url.host == "ssd-api.jpl.nasa.gov"]
    assert (first, second) == ("geocentre", "SPHEREx")
    assert ["mpc-code" in p for p in sbident] == [True, False]
    assert sbident[1]["xobs"].endswith(",0,0,0") and {o.observer for o in objs} == {"SPHEREx"}


@pytest.mark.asyncio
async def test_sbident_field_is_as_wide_in_ra_as_the_square_at_its_edge_nearest_the_pole():
    asked: list[httpx.Request] = []
    catalogs._SB_CACHE.clear()
    catalogs._SPHEREX_AT.clear()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_jpl(httpx.Response(503), asked))
    ) as client:
        await catalogs.sbident_field(120.0, 60.0, 0.2, 61055.0, client)
    params = asked[-1].url.params
    # 0.2° at Dec 60.2° spans 0.2 / cos(60.2°) ≈ 0.402° of RA; Dec keeps 0.2°.
    assert (params["fov-ra-hwidth"], params["fov-dec-hwidth"]) == ("0.4024", "0.2000")
