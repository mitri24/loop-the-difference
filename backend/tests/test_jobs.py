import re

import pytest
from rq.exceptions import NoSuchJobError

from app import archive, jobs, worker

ARGS = ("spherex_dr1", 133.795, -7.245, 0.2, 6, 12)


def test_job_id_is_a_16_character_fingerprint():
    assert re.fullmatch(r"[0-9a-f]{16}", jobs.job_id_for(*ARGS))
    assert jobs.job_id_for(*ARGS) == jobs.job_id_for(*ARGS)


def test_stacking_gets_its_own_job_and_cache_entry():
    assert jobs.job_id_for(*ARGS, stack=True) != jobs.job_id_for(*ARGS)


def test_pipeline_version_changes_every_fingerprint(monkeypatch):
    before = jobs.job_id_for(*ARGS)
    monkeypatch.setattr(jobs, "PIPELINE_VERSION", jobs.PIPELINE_VERSION + 1)

    assert jobs.job_id_for(*ARGS) != before


class _RecordingQueue:
    names: list[str] = []
    enqueued: list[dict] = []
    count = 0

    def __init__(self, name, **_):
        self.names.append(name)

    def enqueue(self, *_, **options):
        self.enqueued.append(options)


def test_spectra_wait_on_the_slow_queue_and_frames_on_their_own(monkeypatch, settings):
    monkeypatch.setattr(jobs, "Queue", _RecordingQueue)
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: (_ for _ in ()).throw(NoSuchJobError))
    _RecordingQueue.names = []

    jobs.submit_spectrum(None, settings, 133.795, -7.245)
    jobs.submit(None, settings, "0123456789abcdef", ra=133.795, dec=-7.245)

    assert _RecordingQueue.names == [jobs.SLOW_QUEUE, jobs.QUEUE_NAME]


def test_spectrum_job_follows_the_collection_set(monkeypatch, settings):
    monkeypatch.setattr(jobs, "Queue", _RecordingQueue)
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: (_ for _ in ()).throw(NoSuchJobError))
    _RecordingQueue.enqueued = []
    monkeypatch.setattr(
        archive, "_fetch_collections", lambda settings: ["spherex_dr1", "spherex_qr3"]
    )

    job = jobs.submit_spectrum(None, settings, 133.795, -7.245)

    assert job.job_id == jobs.spectrum_job_id("spherex_dr1,spherex_qr3", 133.795, -7.245)
    assert job.job_id != jobs.spectrum_job_id("spherex_dr1", 133.795, -7.245)
    assert _RecordingQueue.enqueued[0]["kwargs"]["collections"] == ["spherex_dr1", "spherex_qr3"]


@pytest.mark.parametrize(
    ("setting", "queues"),
    [("", [jobs.QUEUE_NAME, jobs.SLOW_QUEUE]), ("slow", ["slow"]), (" frames, ", ["frames"])],
)
def test_worker_takes_the_queues_from_its_setting(monkeypatch, settings, setting, queues):
    taken = []

    class _Worker:
        def __init__(self, names, **_):
            taken.extend(names)

        def work(self):
            pass

    monkeypatch.setattr(worker, "Worker", _Worker)
    monkeypatch.setattr(
        worker, "get_settings", lambda: settings.model_copy(update={"worker_queues": setting})
    )

    worker.main()

    assert taken == queues


def test_running_job_serves_preview_without_claiming_completion(monkeypatch, settings):
    from types import SimpleNamespace

    from rq.job import JobStatus

    from app.models import FrameManifest

    preview = FrameManifest(
        collection="spherex_dr1",
        ra=10,
        dec=20,
        size_deg=0.2,
        detector=6,
        pixel_scale_arcsec=6.15,
        epochs=1,
        frames=[],
        warnings=[],
        preview=True,
        complete=False,
    )
    folder = jobs.manifest_path(settings.cache_dir, "job").parent
    folder.mkdir(parents=True)
    (folder / "preview.json").write_text(preview.model_dump_json())
    monkeypatch.setattr(
        jobs.Job,
        "fetch",
        lambda *_, **__: SimpleNamespace(
            meta={"progress": 2, "total": 12},
            get_status=lambda: JobStatus.STARTED,
        ),
    )
    running = jobs.status(None, settings, "job")
    assert running.status == "started"
    assert running.manifest.preview
    assert (running.progress, running.total) == (2, 12)
    final = preview.model_copy(update={"preview": False, "complete": True})
    jobs.manifest_path(settings.cache_dir, "job").write_text(final.model_dump_json())
    finished = jobs.status(None, settings, "job")
    assert finished.status == "finished"
    assert finished.manifest.complete and not finished.manifest.preview
