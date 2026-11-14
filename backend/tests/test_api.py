import json
import time

import pytest
from astropy.coordinates import SkyCoord
from astropy.coordinates.name_resolve import NameResolveError
from rq.exceptions import NoSuchJobError

from app import jobs, names
from app.models import Check, Frame, FrameJob, FrameManifest
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
    assert client.get("/api/frames/0123456789abcdef/diff_0_1.png").status_code == 404


def test_difference_images_are_served_like_frames(client, settings):
    job_dir = settings.cache_dir / "frames" / "0123456789abcdef"
    job_dir.mkdir(parents=True)
    (job_dir / "diff_00_01.png").write_bytes(b"PNG")

    response = client.get("/api/frames/0123456789abcdef/diff_00_01.png")

    assert response.status_code == 200
    assert response.content == b"PNG"


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
        warnings=["No usable time baseline: all usable observations come from one epoch"],
        checks=[
            Check(
                code="NO_TIME_BASELINE",
                severity="blocker",
                message="All usable observations come from one epoch",
                affects=["difference"],
            )
        ],
    )
    path = manifest_path(settings.cache_dir, job_id)
    path.parent.mkdir(parents=True)
    path.write_text(manifest.model_dump_json())

    response = client.get(f"/api/frames/{job_id}")

    assert response.status_code == 200
    assert response.json()["status"] == "finished"
    served = response.json()["manifest"]
    assert served["frames"][0]["obs_id"] == "2025W19_1B_0116_1"
    assert served["checks"][0]["code"] == "NO_TIME_BASELINE"
    assert served["differences"] == []


def test_manifest_written_before_contract_v2_still_parses(client, settings):
    job_id = "0123456789abcdef"
    old_manifest = {
        "collection": "spherex_dr1",
        "ra": 133.795,
        "dec": -7.245,
        "size_deg": 0.2,
        "detector": 6,
        "pixel_scale_arcsec": 6.15,
        "epochs": 2,
        "complete": True,
        "frames": [
            {
                "index": 0,
                "url": f"/api/frames/{job_id}/frame_00.png",
                "obs_id": "2025W19_1B_0116_1",
                "date": "2025-05-05T16:49:00Z",
                "mjd": 60800.7,
                "detector": 6,
                "wavelength_min_um": 4.4,
                "wavelength_max_um": 5.0,
                "coverage": 1.0,
                "source_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/example.fits",
            }
        ],
        "warnings": [],
    }
    path = manifest_path(settings.cache_dir, job_id)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(old_manifest))

    response = client.get(f"/api/frames/{job_id}")

    assert response.status_code == 200
    served = response.json()["manifest"]
    assert served["stacked"] is False
    assert served["checks"] == [] and served["differences"] == []
    frame = served["frames"][0]
    assert (frame["epoch"], frame["n_combined"], frame["wavelength_um"]) == (0, 1, None)


class _FullQueue:
    count = 21

    def __init__(self, *_, **__):
        pass

    def enqueue(self, *_, **__):
        raise AssertionError("a full queue must not accept new jobs")


def test_new_frames_are_refused_while_the_queue_is_full(client, monkeypatch):
    monkeypatch.setattr(
        jobs, "status", lambda *_: FrameJob(job_id="0123456789abcdef", status="not_found")
    )
    monkeypatch.setattr(jobs, "Queue", _FullQueue)

    response = client.post("/api/frames", json={"ra": "133.795", "dec": "-7.245"})

    assert response.status_code == 503
    assert response.json()["detail"] == "Busy – please try again in a minute"


def test_running_job_is_returned_even_while_the_queue_is_full(client, monkeypatch):
    running = FrameJob(job_id="0123456789abcdef", status="started", progress=3, total=12)
    monkeypatch.setattr(jobs, "status", lambda *_: running)
    monkeypatch.setattr(jobs, "Queue", _FullQueue)

    response = client.post("/api/frames", json={"ra": "133.795", "dec": "-7.245"})

    assert response.status_code == 200
    assert response.json()["status"] == "started"


@pytest.fixture
def resolver(monkeypatch):
    """Replace Sesame with an offline resolver; returns the list of looked-up names."""
    names._lookup.cache_clear()
    calls: list[str] = []

    class FakeSkyCoord:
        @staticmethod
        def from_name(name: str) -> SkyCoord:
            calls.append(name)
            if name.startswith("slow"):
                time.sleep(0.2)
            if name.startswith("unknown"):
                raise NameResolveError(name)
            return SkyCoord(269.45, 4.69, unit="deg")

    monkeypatch.setattr(names, "SkyCoord", FakeSkyCoord)
    return calls


def test_resolved_names_are_cached(client, resolver):
    for _ in range(2):
        response = client.get("/api/resolve", params={"name": "Barnard's Star"})
        assert response.status_code == 200
        assert response.json() == {"name": "Barnard's Star", "ra": 269.45, "dec": 4.69}

    assert resolver == ["Barnard's Star"]


def test_unknown_name_is_not_cached(client, resolver):
    for _ in range(2):
        response = client.get("/api/resolve", params={"name": "unknown thing"})
        assert response.status_code == 404

    assert resolver == ["unknown thing", "unknown thing"]


def test_slow_name_lookup_times_out(client, resolver, monkeypatch):
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT_S", 0.05)

    response = client.get("/api/resolve", params={"name": "slow star"})

    assert response.status_code == 504
    assert response.json()["detail"] == "Name lookup timed out – try coordinates"


def _no_such_job(*_, **__):
    raise NoSuchJobError()


def test_queue_at_the_limit_still_accepts_a_job(client, monkeypatch):
    enqueued = []

    class _AtLimitQueue(_FullQueue):
        count = 20

        def enqueue(self, *_, **kwargs):
            enqueued.append(kwargs["job_id"])

    monkeypatch.setattr(
        jobs, "status", lambda *_: FrameJob(job_id="0123456789abcdef", status="not_found")
    )
    monkeypatch.setattr(jobs, "Queue", _AtLimitQueue)
    monkeypatch.setattr(jobs.Job, "fetch", _no_such_job)

    response = client.post("/api/frames", json={"ra": "133.795", "dec": "-7.245"})

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert len(enqueued) == 1


class _SpectrumJob:
    def __init__(self, state, complete=True):
        self.state, self.complete, self.meta, self.deleted = state, complete, {}, False

    def get_status(self):
        return self.state

    def return_value(self):
        spectrum = {"collection": "spherex_dr1", "ra": 1.0, "dec": 2.0, "points": []}
        return {**spectrum, "complete": self.complete}

    def latest_result(self):
        return None

    def delete(self):
        self.deleted = True


def test_finished_spectrum_comes_from_the_job_result(client, monkeypatch):
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: _SpectrumJob(jobs.JobStatus.FINISHED))

    response = client.get("/api/spectrum/0123456789abcdef")

    assert response.status_code == 200
    assert response.json()["status"] == "finished"
    assert response.json()["spectrum"]["points"] == []


@pytest.mark.parametrize(
    ("state", "complete", "rerun"),
    [
        (jobs.JobStatus.FINISHED, True, False),
        (jobs.JobStatus.STARTED, True, False),
        (jobs.JobStatus.FINISHED, False, True),
        (jobs.JobStatus.FAILED, True, True),
        (jobs.JobStatus.STOPPED, True, True),
    ],
)
def test_spectrum_is_rebuilt_only_when_it_is_missing_or_incomplete(
    client, monkeypatch, state, complete, rerun
):
    previous = _SpectrumJob(state, complete)
    enqueued = []

    class _Queue(_FullQueue):
        count = 0

        def enqueue(self, *_, **kwargs):
            enqueued.append(kwargs["kwargs"])

    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: previous)
    monkeypatch.setattr(jobs, "Queue", _Queue)

    response = client.post("/api/spectrum", json={"ra": "133.795", "dec": "-7.245"})

    assert response.status_code == 200
    assert enqueued == ([{"ra": 133.795, "dec": -7.245}] if rerun else [])
    assert previous.deleted is rerun


def test_spectrum_rejects_invalid_coordinates_and_job_ids(client):
    assert client.post("/api/spectrum", json={"ra": "nope", "dec": "1"}).status_code == 422
    assert client.get("/api/spectrum/..").status_code == 404
