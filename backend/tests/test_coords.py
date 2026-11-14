import pytest

from app.coords import CoordinateError, parse_dec, parse_ra


def test_decimal_input_is_degrees():
    assert parse_ra("133.795") == pytest.approx(133.795)
    assert parse_dec("-7.245") == pytest.approx(-7.245)


def test_sexagesimal_wise_0855_from_the_challenge():
    assert parse_ra("08h55m10.831s") == pytest.approx(133.795129, abs=1e-5)
    assert parse_dec("-7d14m42.53s") == pytest.approx(-7.245147, abs=1e-5)


def test_colon_notation_polaris():
    assert parse_ra("02:31:49.09") == pytest.approx(37.954542, abs=1e-5)
    assert parse_dec("+89:15:50.8") == pytest.approx(89.264111, abs=1e-5)


@pytest.mark.parametrize("value", ["", "  ", "abc", "nan", "inf", "360", "-0.5", "24h"])
def test_invalid_right_ascension(value):
    with pytest.raises(CoordinateError, match="Invalid right ascension"):
        parse_ra(value)


@pytest.mark.parametrize("value", ["", "abc", "nan", "-inf", "90.01", "-91"])
def test_invalid_declination(value):
    with pytest.raises(CoordinateError, match="Invalid declination"):
        parse_dec(value)
