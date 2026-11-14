import re

import pytest
from rq.exceptions import NoSuchJobError

from app import jobs, worker

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
    count = 0

    def __init__(self, name, **_):
        self.names.append(name)

    def enqueue(self, *_, **__):
        pass


def test_spectra_wait_on_the_slow_queue_and_frames_on_their_own(monkeypatch, settings):
    monkeypatch.setattr(jobs, "Queue", _RecordingQueue)
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: (_ for _ in ()).throw(NoSuchJobError))
    _RecordingQueue.names = []

    jobs.submit_spectrum(None, settings, 133.795, -7.245)
    jobs.submit(None, settings, "0123456789abcdef", ra=133.795, dec=-7.245)

    assert _RecordingQueue.names == [jobs.SLOW_QUEUE, jobs.QUEUE_NAME]


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
