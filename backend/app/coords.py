import math
import re

from astropy import units as u
from astropy.coordinates import Angle

_DECIMAL = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)$")


class CoordinateError(ValueError):
    pass


def parse_ra(text: str) -> float:
    """Right ascension in degrees. Decimal input is degrees, sexagesimal input is hours."""
    value = _parse(text, u.hourangle, "Invalid right ascension")
    if not 0 <= value < 360:
        raise CoordinateError("Invalid right ascension")
    return value


def parse_dec(text: str) -> float:
    value = _parse(text, u.deg, "Invalid declination")
    if not -90 <= value <= 90:
        raise CoordinateError("Invalid declination")
    return value


def _parse(text: str, unit: u.Unit, message: str) -> float:
    value_text = text.strip()
    if not value_text:
        raise CoordinateError(message)
    try:
        if _DECIMAL.match(value_text):
            value = float(value_text)
        else:
            value = float(Angle(value_text, unit=unit).deg)
    except (ValueError, TypeError, u.UnitsError):
        raise CoordinateError(message) from None
    if not math.isfinite(value):
        raise CoordinateError(message)
    # Sexagesimal conversion can land a hair below a limit (24h -> 359.99999999999994).
    return round(value, 9)
