"""Input validation for sky positions and fields of view (Rules.md §03).

All user-supplied coordinates go through :func:`parse_ra` / :func:`parse_dec`. They
accept decimal degrees or sexagesimal strings and raise :class:`InputError` with a
user-facing message for anything invalid (text, NaN/Inf, out of range).
"""

from __future__ import annotations

import math
import re

from .config import settings


class InputError(ValueError):
    """Invalid user input. ``code`` is stable and used by the frontend/tests."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_SEXA = re.compile(
    r"^\s*([+-]?)\s*(\d{1,3})\s*[:hd°\s]\s*(\d{1,2})\s*[:m'′\s]\s*(\d{1,2}(?:\.\d*)?)\s*[s\"″]?\s*$",
    re.IGNORECASE,
)


def _parse_sexagesimal(text: str) -> tuple[int, float] | None:
    m = _SEXA.match(text)
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    a, b, c = float(m.group(2)), float(m.group(3)), float(m.group(4))
    if b >= 60 or c >= 60:
        return None
    return sign, a + b / 60 + c / 3600


def _finite(value: float, code: str, what: str) -> float:
    if not math.isfinite(value):
        raise InputError(code, f"Invalid {what}: value must be a finite number.")
    return value


def parse_ra(value: str | float) -> float:
    """Return right ascension in degrees, in [0, 360).

    Sexagesimal input (``08h55m10.831s`` or ``08:55:10.831``) is interpreted as hours.
    """
    code, what = "invalid_ra", "right ascension"
    if isinstance(value, int | float):
        deg = _finite(float(value), code, what)
    else:
        text = str(value).strip()
        if not text:
            raise InputError(code, "Invalid right ascension: empty value.")
        sexa = _parse_sexagesimal(text)
        if sexa is not None:
            sign, hours = sexa
            if sign < 0:
                raise InputError(code, "Invalid right ascension: must not be negative.")
            deg = hours * 15.0
        else:
            try:
                deg = float(text.rstrip("d°"))
            except ValueError as exc:
                raise InputError(
                    code, f"Invalid right ascension: {text!r} is not a number or hh:mm:ss."
                ) from exc
            deg = _finite(deg, code, what)
    if not 0.0 <= deg < 360.0:
        raise InputError(code, f"Invalid right ascension: {deg} is outside [0, 360) degrees.")
    return deg


def parse_dec(value: str | float) -> float:
    """Return declination in degrees, in [-90, 90]."""
    code, what = "invalid_dec", "declination"
    if isinstance(value, int | float):
        deg = _finite(float(value), code, what)
    else:
        text = str(value).strip()
        if not text:
            raise InputError(code, "Invalid declination: empty value.")
        sexa = _parse_sexagesimal(text)
        if sexa is not None:
            sign, d = sexa
            deg = sign * d
        else:
            try:
                deg = float(text.rstrip("d°"))
            except ValueError as exc:
                raise InputError(
                    code, f"Invalid declination: {text!r} is not a number or dd:mm:ss."
                ) from exc
            deg = _finite(deg, code, what)
    if not -90.0 <= deg <= 90.0:
        raise InputError(code, f"Invalid declination: {deg} is outside [-90, 90] degrees.")
    return deg


def parse_fov(arcmin: float | None) -> float:
    """Clamp-check the requested field of view (arcmin)."""
    if arcmin is None:
        return settings.default_fov_arcmin
    if not math.isfinite(arcmin):
        raise InputError("invalid_fov", "Invalid field of view: must be a finite number.")
    if not settings.min_fov_arcmin <= arcmin <= settings.max_fov_arcmin:
        raise InputError(
            "invalid_fov",
            f"Invalid field of view: {arcmin}' is outside "
            f"[{settings.min_fov_arcmin}', {settings.max_fov_arcmin}'].",
        )
    return float(arcmin)


BANDS = ("D1", "D2", "D3", "D4", "D5", "D6")


def parse_band(band: str) -> str:
    b = band.strip().upper().removeprefix("SPHEREX-")
    if b not in BANDS:
        raise InputError("invalid_band", f"Invalid band {band!r}: expected one of {BANDS}.")
    return b
