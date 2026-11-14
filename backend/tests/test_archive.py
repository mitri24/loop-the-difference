from pathlib import Path

from app.archive import group_epochs, parse_sia_votable, select_frames, summarize
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


def test_epochs_split_on_gaps_longer_than_a_month():
    epochs = group_epochs([_obs(100), _obs(102), _obs(290), _obs(291), _obs(470)])

    assert [len(epoch) for epoch in epochs] == [2, 2, 1]


def test_frame_selection_keeps_every_epoch():
    first = [_obs(100 + i * 0.5) for i in range(10)]
    second = [_obs(290 + i * 0.5) for i in range(10)]

    selected = select_frames(first + second, max_frames=4)

    assert len(selected) == 4
    assert {len(epoch) for epoch in group_epochs(selected)} == {2}


def test_summary_counts_detectors_and_epochs():
    summary = summarize(1.0, 2.0, "spherex_dr1", [_obs(100, 1), _obs(101, 6), _obs(300, 6)])

    assert summary.count == 3
    assert summary.detectors == {1: 1, 6: 2}
    assert [epoch.count for epoch in summary.epochs] == [2, 1]
