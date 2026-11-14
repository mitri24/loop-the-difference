import pytest

from app.tasks import epoch_checks


@pytest.mark.parametrize(
    ("usable", "epochs", "code", "severity"),
    [
        (0, 0, "NO_OBSERVATIONS", "error"),
        (1, 1, "SINGLE_EPOCH", "blocker"),
        (3, 1, "NO_TIME_BASELINE", "blocker"),
    ],
)
def test_too_little_data_blocks_the_comparison(usable, epochs, code, severity):
    (check,) = epoch_checks(usable, epochs)

    assert (check.code, check.severity) == (code, severity)
    assert check.affects == ["difference"]
    assert check.detail


def test_two_epochs_pass_without_a_check():
    assert epoch_checks(4, 2) == []
