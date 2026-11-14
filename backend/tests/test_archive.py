import os
from pathlib import Path

import httpx
import pytest

from app import archive
from app.archive import (
    ArchiveError,
    _fetch_collections,
    collections_cache_path,
    group_epochs,
    parse_cloud_access,
    parse_collections,
    parse_sia_votable,
    release_label,
    resolve_cache_path,
    resolve_position,
    search_observations,
    select_for_stacks,
    select_frames,
    sia_cache_path,
    spherex_collections,
    summarize,
)
from app.models import Observation

# Real IRSA SIA2 answer for WISE 0855 (spherex_dr1), trimmed to six rows.
FIXTURE = Path(__file__).parent / "fixtures" / "sia_wise0855.xml"
# Real IRSA SIA2 self-description (`?MAXREC=0`), trimmed to eight COLLECTION options.
SELF_DESCRIPTION = Path(__file__).parent / "fixtures" / "sia_self_description.xml"


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

    first, _ = search_observations(133.79513, -7.24515, settings)
    monkeypatch.setattr("app.archive.httpx.get", lambda *a, **k: pytest.fail("network use"))
    second, _ = search_observations(133.79513, -7.24515, settings)

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

    assert search_observations(1.0, 2.0, settings) == ([], [])
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


class _Answer:
    def __init__(self, content: bytes):
        self.content = content

    def raise_for_status(self):
        pass


def test_self_description_lists_only_spherex_image_collections():
    assert parse_collections(SELF_DESCRIPTION.read_bytes()) == [
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr3",
        "spherex_qr3_deep",
    ]


def test_collection_list_is_cached_for_a_day(settings, monkeypatch):
    monkeypatch.setattr(archive, "_fetch_collections", _fetch_collections)
    calls = []

    def fake_get(url, params, timeout):
        calls.append(params)
        return _Answer(SELF_DESCRIPTION.read_bytes())

    monkeypatch.setattr("app.archive.httpx.get", fake_get)

    first = spherex_collections(settings)
    second = spherex_collections(settings)

    assert calls == [{"MAXREC": "0"}]
    assert first == second == ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
    cached = collections_cache_path(settings.cache_dir)
    os.utime(cached, (0, 0))  # a day old: asked again
    spherex_collections(settings)
    assert len(calls) == 2


def test_collection_list_falls_back_when_irsa_is_silent(settings, monkeypatch):
    def unreachable(settings):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(archive, "_fetch_collections", unreachable)
    assert spherex_collections(settings) == ["spherex_dr1"]
    assert not collections_cache_path(settings.cache_dir).exists()

    collections_cache_path(settings.cache_dir).write_text('["spherex_dr1", "spherex_qr3"]')
    os.utime(collections_cache_path(settings.cache_dir), (0, 0))
    assert spherex_collections(settings) == ["spherex_dr1", "spherex_qr3"]
    # The old list holds for an hour: requests do not wait on a silent IRSA every time.
    monkeypatch.setattr(archive, "_fetch_collections", lambda s: pytest.fail("asked again"))
    assert spherex_collections(settings) == ["spherex_dr1", "spherex_qr3"]


def _per_collection(answers: dict[str, bytes | None]):
    def fake_get(url, params, timeout):
        content = answers[params["COLLECTION"]]
        if content is None:
            raise httpx.ConnectError("503 Server busy")
        return _Answer(content)

    return fake_get


def test_search_merges_every_collection_and_keeps_the_collection(settings, monkeypatch):
    # The same six rows as a QR3 answer under other obs_ids.
    qr3 = FIXTURE.read_bytes().replace(b"2025W", b"2026W")
    monkeypatch.setattr(
        "app.archive.httpx.get",
        _per_collection({"spherex_dr1": FIXTURE.read_bytes(), "spherex_qr3": qr3}),
    )

    found, failed = search_observations(1.0, 2.0, settings, ["spherex_dr1", "spherex_qr3"])

    assert failed == []
    assert len(found) == 12
    assert [o.mjd for o in found] == sorted(o.mjd for o in found)
    assert {o.collection for o in found} == {"spherex_dr1", "spherex_qr3"}
    assert sia_cache_path(settings.cache_dir, "spherex_qr3", 1.0, 2.0).is_file()


def test_an_empty_release_is_cached_when_another_release_has_data(settings, monkeypatch):
    empty = FIXTURE.read_bytes().replace(b"science", b"calibration")
    monkeypatch.setattr(
        "app.archive.httpx.get",
        _per_collection({"spherex_dr1": FIXTURE.read_bytes(), "spherex_qr3_deep": empty}),
    )

    search_observations(1.0, 2.0, settings, ["spherex_dr1", "spherex_qr3_deep"])
    monkeypatch.setattr("app.archive.httpx.get", lambda *a, **k: pytest.fail("network use"))
    found, failed = search_observations(1.0, 2.0, settings, ["spherex_dr1", "spherex_qr3_deep"])

    assert (len(found), failed) == (6, [])


def test_one_failing_collection_does_not_fail_the_search(settings, monkeypatch):
    monkeypatch.setattr(
        "app.archive.httpx.get",
        _per_collection({"spherex_dr1": FIXTURE.read_bytes(), "spherex_qr3": None}),
    )

    found, failed = search_observations(1.0, 2.0, settings, ["spherex_dr1", "spherex_qr3"])

    assert len(found) == 6
    assert failed == ["spherex_qr3"]


def test_search_fails_when_every_collection_fails(settings, monkeypatch):
    monkeypatch.setattr(
        "app.archive.httpx.get", _per_collection({"spherex_dr1": None, "spherex_qr3": None})
    )

    with pytest.raises(ArchiveError, match="not reachable"):
        search_observations(1.0, 2.0, settings, ["spherex_dr1", "spherex_qr3"])


@pytest.mark.parametrize(
    ("collection", "label"),
    [
        ("spherex_dr1", "DR1"),
        ("spherex_qr3", "QR3"),
        ("spherex_dr1_deep", "DR1 deep"),
        ("spherex_qr3_deep", "QR3 deep"),
        ("neossat", "neossat"),
    ],
)
def test_release_label(collection, label):
    assert release_label(collection) == label
