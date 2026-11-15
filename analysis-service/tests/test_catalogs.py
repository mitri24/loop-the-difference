"""Parsers for external services, on recorded real responses (no network)."""

import json
from pathlib import Path

import httpx
import pytest

from app import catalogs

DATA = Path(__file__).parent / "data"


@pytest.mark.asyncio
async def test_sbident_parsing_on_recorded_response():
    body = json.loads((DATA / "sbident_sample.json").read_text())

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["mpc-code"] == "500"
        assert request.url.params["fov-ra-center"] == "08-00-00.00"
        return httpx.Response(200, json=body)

    catalogs._SB_CACHE.clear()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        objs = await catalogs.sbident_field(120.0, 20.0, 0.2, 61055.0, client)
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
