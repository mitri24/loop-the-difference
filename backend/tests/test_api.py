from app.models import Frame, FrameManifest
from app.tasks import manifest_path


def test_health_reports_an_unavailable_queue(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["redis"] == "unavailable"


def test_invalid_coordinates_are_rejected_before_any_archive_call(client):
    response = client.get("/api/observations", params={"ra": "abc", "dec": "0"})

    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid right ascension"


def test_frame_files_cannot_escape_the_cache(client):
    assert client.get("/api/frames/0123456789abcdef/manifest.json").status_code == 404
    assert client.get("/api/frames/not-a-job/frame_00.png").status_code == 404


def test_finished_job_is_served_from_the_cache_without_the_queue(client, settings):
    job_id = "0123456789abcdef"
    manifest = FrameManifest(
        collection="spherex_dr1",
        ra=133.795,
        dec=-7.245,
        size_deg=0.2,
        detector=6,
        pixel_scale_arcsec=6.15,
        epochs=2,
        frames=[
            Frame(
                index=0,
                url=f"/api/frames/{job_id}/frame_00.png",
                obs_id="2025W19_1B_0116_1",
                date="2025-05-05T16:49:00Z",
                mjd=60800.7,
                detector=6,
                wavelength_min_um=4.4,
                wavelength_max_um=5.0,
                coverage=1.0,
                source_url="https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/example.fits",
            )
        ],
        warnings=[],
    )
    path = manifest_path(settings.cache_dir, job_id)
    path.parent.mkdir(parents=True)
    path.write_text(manifest.model_dump_json())

    response = client.get(f"/api/frames/{job_id}")

    assert response.status_code == 200
    assert response.json()["status"] == "finished"
    assert response.json()["manifest"]["frames"][0]["obs_id"] == "2025W19_1B_0116_1"
