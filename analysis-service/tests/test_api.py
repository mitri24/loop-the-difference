from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_and_config():
    assert client.get("/api/health").json()["status"] == "ok"
    cfg = client.get("/api/config").json()
    assert set(cfg["bands"]) == {"D1", "D2", "D3", "D4", "D5", "D6"}
    assert len(cfg["demo_targets"]) == 5
    assert cfg["hips"][0]["cube"] is True


def test_observations_rejects_bad_input_before_any_network_call():
    r = client.get("/api/observations", params={"ra": "abc", "dec": "4"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_ra"
    r = client.get("/api/observations", params={"ra": "10", "dec": "95"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_dec"
    r = client.get("/api/observations", params={"ra": "10", "dec": "5", "fov": 99})
    assert r.status_code == 422 and r.json()["code"] == "invalid_fov"


def test_sequence_job_validates_synchronously():
    r = client.post(
        "/api/jobs/sequence", json={"ra": "nan", "dec": 0, "band": "D1", "mode": "stack"}
    )
    assert r.status_code == 422


def test_frame_file_name_is_sanitised():
    r = client.get("/api/frames/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code in (400, 404)
    assert "root:" not in r.text
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api/frames/abc.png").status_code == 400


def test_unknown_job():
    assert client.get("/api/jobs/nope").status_code == 404


def test_catalog_serves_catwise_motions_and_says_502_when_irsa_fails(monkeypatch):
    from app import main
    from app.schemas import CatalogSource

    mover = CatalogSource(
        catalog="CatWISE2020",
        id="CatWISE2020 J085509.47-071502.9",
        ra=133.79,
        dec=-7.25,
        mag=15.0,
        mag_band="W1",
        pm_ra_mas_yr=-8100.0,
        pm_dec_mas_yr=680.0,
        epoch_jyear=2015.22,
    )
    asked = []

    async def catwise(ra, dec, radius_deg, client):
        asked.append((ra, dec, radius_deg))
        return [mover]

    monkeypatch.setattr(main, "catwise_cone", catwise)
    res = client.get(
        "/api/catalog",
        params={"ra": "133.79", "dec": "-7.25", "radius_arcmin": 6, "catalog": "catwise"},
    )
    assert res.status_code == 200
    assert res.json()[0]["pm_ra_mas_yr"] == -8100.0 and res.json()[0]["epoch_jyear"] == 2015.22
    assert asked == [(133.79, -7.25, 0.1)]

    async def no_table(ra, dec, radius_deg, client):
        raise ValueError("IRSA Gator answered no catwise_2020 table")

    monkeypatch.setattr(main, "catwise_cone", no_table)
    res = client.get("/api/catalog", params={"ra": "133.79", "dec": "-7.25", "catalog": "catwise"})
    assert res.status_code == 502
