import pytest

from app.comparability import compare_frames
from app.spectral import resolution_element_um

from .conftest import make_frame


def codes(checks):
    return {c.code: c.severity for c in checks}


def test_band_mismatch_blocks():
    ok, checks = compare_frames(make_frame(band="D1"), make_frame(band="D2"))
    assert not ok and codes(checks)["band_mismatch"] == "fail"


def test_wavelength_mismatch_blocks_single_frames():
    a = make_frame(lambda_um=1.20, mjd=60900)
    b = make_frame(lambda_um=1.50, mjd=61100, visit=1)
    ok, checks = compare_frames(a, b)
    assert not ok and codes(checks)["wavelength_mismatch"] == "fail"


@pytest.mark.parametrize(
    ("elements", "code", "severity"),
    [
        (0.4, "wavelength_matched", "ok"),
        (0.8, "wavelength_close", "warn"),
        (1.2, "wavelength_mismatch", "fail"),
    ],
)
def test_wavelength_rule_in_resolution_elements(elements, code, severity):
    """Half a resolution element matches, up to one warns, beyond one fails."""
    a = make_frame(lambda_um=1.30, mjd=60900)
    b = make_frame(
        lambda_um=1.30 + elements * resolution_element_um(1.30, "D2"), mjd=61100, visit=1
    )
    ok, checks = compare_frames(a, b)
    assert codes(checks)[code] == severity and ok == (severity != "fail")


def test_matched_pair_passes():
    a = make_frame(lambda_um=1.300, mjd=60900)
    b = make_frame(lambda_um=1.305, mjd=61100, visit=1)
    ok, checks = compare_frames(a, b)
    c = codes(checks)
    assert ok and c["wavelength_matched"] == "ok" and c["baseline"] == "ok"


def test_same_visit_warns():
    ok, checks = compare_frames(make_frame(mjd=60900), make_frame(mjd=60902))
    assert ok and codes(checks)["same_visit"] == "warn"


def test_stacks_compare_on_band_width_and_flags():
    a = make_frame(kind="stack", lambda_um=1.33, mjd=60900, flags_at_target=["OVERFLOW", "SOURCE"])
    b = make_frame(kind="stack", lambda_um=1.37, mjd=61270, collections=["spherex_qr3"])
    ok, checks = compare_frames(a, b)
    c = codes(checks)
    assert ok
    assert c["stack_wavelength"] == "ok"
    assert c["target_flags"] == "warn"
    flags_check = next(x for x in checks if x.code == "target_flags")
    assert "saturated" in flags_check.title and "OVERFLOW" in flags_check.detail
    assert c["mixed_releases"] == "info"


def test_psf_mismatch_warns():
    _, checks = compare_frames(
        make_frame(psf_fwhm_arcsec=6.0), make_frame(psf_fwhm_arcsec=9.0, mjd=61200)
    )
    assert codes(checks)["psf_mismatch"] == "warn"
