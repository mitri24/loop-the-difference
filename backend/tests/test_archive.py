from pathlib import Path

import pytest

from app.archive import (
    group_epochs,
    parse_cloud_access,
    parse_sia_votable,
    resolve_cache_path,
    resolve_position,
    search_observations,
    select_for_stacks,
    select_frames,
    sia_cache_path,
    summarize,
)
from app.models import Observation

# Real IRSA SIA2 answer for WISE 0855 (spherex_dr1), trimmed to six rows.
FIXTURE = Path(__file__).parent / "fixtures" / "sia_wise0855.xml"


def _obs(mjd: float, detector: int = 6) -> Observation:
    return Observation(
        obs_id=f"obs-{mjd}",
        detector=detector,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=mjd,
        date="2025-05-05T00:00:00Z",
        access_url="https://example.invalid/image.fits",
    )


def test_parse_real_sia_answer():
    observations = parse_sia_votable(FIXTURE.read_bytes())

    assert len(observations) == 6
    assert [o.mjd for o in observations] == sorted(o.mjd for o in observations)
    first = observations[0]
    assert first.detector in range(1, 7)
    assert first.wavelength_min_um < first.wavelength_max_um
    assert first.access_url.startswith("https://irsa.ipac.caltech.edu/")
    assert first.date.startswith("2025-")
    # Every row also lists the same Level-2 file in IRSA's public AWS bucket.
    for obs in observations:
        assert obs.cloud_url == obs.access_url.replace(
            "https://irsa.ipac.caltech.edu/ibe/data/spherex/",
            "https://nasa-irsa-spherex.s3.amazonaws.com/",
        )


@pytest.mark.parametrize("value", [None, "", "--", "null", '{"aws": {"key": "a.fits"}}'])
def test_unusable_cloud_access_gives_no_cloud_url(value):
    assert parse_cloud_access(value) is None


def test_answer_without_cloud_access_column_still_parses():
    content = FIXTURE.read_bytes().replace(b'name="cloud_access"', b'name="other"')

    observations = parse_sia_votable(content)

    assert len(observations) == 6
    assert all(obs.cloud_url is None for obs in observations)


def test_epochs_split_on_gaps_longer_than_a_month():
    epochs = group_epochs([_obs(100), _obs(102), _obs(290), _obs(291), _obs(470)])

    assert [len(epoch) for epoch in epochs] == [2, 2, 1]


def test_frame_selection_keeps_every_epoch():
    first = [_obs(100 + i * 0.5) for i in range(10)]
    second = [_obs(290 + i * 0.5) for i in range(10)]

    selected = select_frames(first + second, max_frames=4)

    assert len(selected) == 4
    assert {len(epoch) for epoch in group_epochs(selected)} == {2}


def test_stack_selection_caps_every_epoch_at_eight():
    epochs = [[_obs(start + i * 0.5) for i in range(10)] for start in (100, 290, 470)]

    selected = select_for_stacks([obs for epoch in epochs for obs in epoch])

    assert [len(epoch) for epoch in group_epochs(selected)] == [8, 8, 8]
    assert selected[0] is epochs[0][0] and selected[7] is epochs[0][-1]


def test_summary_counts_detectors_and_epochs():
    summary = summarize(1.0, 2.0, "spherex_dr1", [_obs(100, 1), _obs(101, 6), _obs(300, 6)])

    assert summary.count == 3
    assert summary.detectors == {1: 1, 6: 2}
    assert [epoch.count for epoch in summary.epochs] == [2, 1]


def test_search_results_are_cached_on_disk(settings, monkeypatch):
    calls = []

    class Response:
        content = FIXTURE.read_bytes()

        def raise_for_status(self):
            pass

    def fake_get(url, params, timeout):
        calls.append(params["POS"])
        return Response()

    monkeypatch.setattr("app.archive.httpx.get", fake_get)

    first = search_observations(133.79513, -7.24515, settings)
    monkeypatch.setattr("app.archive.httpx.get", lambda *a, **k: pytest.fail("network use"))
    second = search_observations(133.79513, -7.24515, settings)

    assert calls == ["CIRCLE 133.79513 -7.24515 0.0005"]
    assert [o.obs_id for o in first] == [o.obs_id for o in second]
    assert sia_cache_path(settings.cache_dir, "spherex_dr1", 133.79513, -7.24515).is_file()
    assert not list((settings.cache_dir / "sia").glob("*.part"))


def test_empty_search_answers_are_not_cached(settings, monkeypatch):
    empty = FIXTURE.read_bytes().replace(b"science", b"calibration")

    class Response:
        content = empty

        def raise_for_status(self):
            pass

    monkeypatch.setattr("app.archive.httpx.get", lambda *a, **k: Response())

    assert search_observations(1.0, 2.0, settings) == []
    assert not (settings.cache_dir / "sia").exists()


def test_resolved_names_are_cached_on_disk(settings, monkeypatch):
    monkeypatch.setattr(
        "app.archive.names.resolve", lambda name: (269.4520769586187, 4.69336496657667)
    )

    first = resolve_position("Barnard's Star", settings)
    monkeypatch.setattr("app.archive.names.resolve", lambda name: pytest.fail("network use"))
    second = resolve_position("Barnard's Star", settings)

    assert first == second == (269.4520769586187, 4.69336496657667)
    assert resolve_cache_path(settings.cache_dir, "Barnard's Star").is_file()
