import re

from app import jobs

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
