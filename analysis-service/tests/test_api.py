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
