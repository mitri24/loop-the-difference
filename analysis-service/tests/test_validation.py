"""Rules.md §03 — input validation table."""

import math

import pytest

from app.validation import InputError, parse_band, parse_dec, parse_fov, parse_ra


@pytest.mark.parametrize(
    ("text", "deg"),
    [
        ("133.7951", 133.7951),
        ("08h55m10.831s", 133.79513),  # WISE 0855 as written in the challenge
        ("08:55:10.831", 133.79513),
        ("08 55 10.831", 133.79513),
        (0, 0.0),
        ("359.9999", 359.9999),
    ],
)
def test_ra_valid(text, deg):
    assert parse_ra(text) == pytest.approx(deg, abs=1e-5)


@pytest.mark.parametrize(
    "bad", ["abc", "", "nan", "inf", math.nan, math.inf, 360, -1, "25:00:00", "-01:00:00"]
)
def test_ra_invalid(bad):
    with pytest.raises(InputError) as e:
        parse_ra(bad)
    assert e.value.code == "invalid_ra"
    assert "right ascension" in e.value.message.lower()


@pytest.mark.parametrize(
    ("text", "deg"),
    [
        ("-7d14m42.53s", -7.245147),
        ("-07:14:42.53", -7.245147),
        ("+66:45:17.9", 66.754972),
        ("90", 90.0),
        (-90, -90.0),
    ],
)
def test_dec_valid(text, deg):
    assert parse_dec(text) == pytest.approx(deg, abs=1e-5)


@pytest.mark.parametrize("bad", ["x", "", 95, -90.5, "91:00:00", math.nan, "12:61:00"])
def test_dec_invalid(bad):
    with pytest.raises(InputError) as e:
        parse_dec(bad)
    assert e.value.code == "invalid_dec"


def test_fov_limits():
    assert parse_fov(None) > 0
    with pytest.raises(InputError):
        parse_fov(0.5)
    with pytest.raises(InputError):
        parse_fov(math.nan)


def test_band():
    assert parse_band("spherex-d3") == "D3"
    with pytest.raises(InputError):
        parse_band("D7")
