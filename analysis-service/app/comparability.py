"""Are two aligned frames comparable? (Rules.md "IMPORTANT SCIENCE CHECK").

Two SPHEREx images of the same region are NOT automatically comparable. We check
band, effective wavelength, time baseline, coverage, data-quality flags at the
target, PSF width, noise and processing version. The difference image is only
enabled when no check FAILS; warnings are shown next to it.

Thresholds live here, with the reasoning, so they can be reviewed in one place
(see docs/SCIENCE.md and QUALITY.md).
"""

from __future__ import annotations

from .config import settings
from .cutouts import ARTIFACT_FLAGS, DEGRADED_FLAGS, HARD_FLAGS
from .releases import describe
from .schemas import Check, Frame
from .spectral import BANDS, resolution_element_um

# Broadband (per-visit stack) frames mix many LVF channels. Their effective
# wavelengths are compared to the band width instead of one resolution element.
STACK_LAMBDA_TOLERANCE = 0.10  # fraction of the band width
PSF_RATIO_WARN = 1.25
NOISE_RATIO_WARN = 2.0
COVERAGE_WARN = 0.9


def compare_frames(a: Frame, b: Frame) -> tuple[bool, list[Check]]:
    checks: list[Check] = []

    # 1. Band ------------------------------------------------------------------------
    if a.band != b.band:
        checks.append(
            Check(
                code="band_mismatch",
                severity="fail",
                title="Different detector bands",
                detail=f"{a.band} vs {b.band}: different wavelengths, PSFs and calibration.",
            )
        )
        return False, checks

    band = BANDS[a.band]
    # 2. Wavelength ------------------------------------------------------------------
    dlam = abs(a.lambda_um - b.lambda_um)
    if a.kind == "single" and b.kind == "single":
        res = resolution_element_um(0.5 * (a.lambda_um + b.lambda_um), a.band)
        tol = settings.wavelength_match_fraction * res
        if dlam <= tol:
            checks.append(
                Check(
                    code="wavelength_matched",
                    severity="ok",
                    title=f"Wavelength matched (Δλ = {dlam * 1000:.1f} nm)",
                    detail=f"Within {settings.wavelength_match_fraction:g} × λ/R "
                    f"(λ/R = {res * 1000:.1f} nm, R = {band.resolving_power:g}).",
                )
            )
        elif dlam <= 2 * res:
            checks.append(
                Check(
                    code="wavelength_close",
                    severity="warn",
                    title=f"Wavelengths differ by {dlam / res:.1f} resolution elements",
                    detail="Spectral features (e.g. molecular bands) can mimic variability. "
                    "Treat flux changes with caution; positions remain comparable.",
                )
            )
        else:
            checks.append(
                Check(
                    code="wavelength_mismatch",
                    severity="fail",
                    title=f"Wavelengths not comparable (Δλ = {dlam:.3f} µm)",
                    detail=f"{a.lambda_um:.3f} µm vs {b.lambda_um:.3f} µm is "
                    f"{dlam / res:.1f} × λ/R. Direct difference disabled until matched: "
                    "use 'matched' mode or per-visit stacks.",
                )
            )
    else:
        width = band.lam_max_um - band.lam_min_um
        sev = "ok" if dlam <= STACK_LAMBDA_TOLERANCE * width else "warn"
        checks.append(
            Check(
                code="stack_wavelength",
                severity=sev,
                title=f"Broadband stacks: Δλ_eff = {dlam:.3f} µm",
                detail=f"A: {a.lambda_min_um:.2f}-{a.lambda_max_um:.2f} µm "
                f"({a.n_exposures} exp.), B: {b.lambda_min_um:.2f}-{b.lambda_max_um:.2f} µm "
                f"({b.n_exposures} exp.). Positions are comparable; fluxes of sources "
                "with strong spectral features may differ.",
            )
        )

    # 3. Time baseline ---------------------------------------------------------------
    dt = abs(a.mjd - b.mjd)
    if dt < settings.visit_gap_days:
        checks.append(
            Check(
                code="same_visit",
                severity="warn",
                title=f"Same visit (Δt = {dt:.1f} days)",
                detail="Only fast movers (asteroids, comets) can move in this time. "
                "Differences are dominated by wavelength changes.",
            )
        )
    else:
        checks.append(
            Check(
                code="baseline",
                severity="ok",
                title=f"Time baseline {dt:.0f} days ({dt / 365.25:.2f} yr)",
                detail='A source moving > ~6"/baseline (one pixel) can be seen.',
            )
        )

    # 4. Coverage --------------------------------------------------------------------
    low = [f for f in (a, b) if f.coverage < COVERAGE_WARN]
    if low:
        checks.append(
            Check(
                code="partial_coverage",
                severity="warn",
                title="Partial overlap",
                detail="; ".join(f"{f.visit_label}: {f.coverage:.0%} of field" for f in low)
                + ". Edges of the difference image are not meaningful.",
            )
        )

    # 5. Flags at the target ---------------------------------------------------------
    # One check per frame that summarises every flag class found at the target.
    for f in (a, b):
        found = set(f.flags_at_target)
        parts = []
        if found & DEGRADED_FLAGS:
            parts.append(
                (
                    f"saturated ({', '.join(sorted(found & DEGRADED_FLAGS))})",
                    "flux estimated from the samples before saturation; position is fine, "
                    "brightness less reliable",
                )
            )
        if found & HARD_FLAGS:
            parts.append(
                (
                    f"masked pixels ({', '.join(sorted(found & HARD_FLAGS))})",
                    "those pixels are excluded; target photometry is unreliable",
                )
            )
        if found & ARTIFACT_FLAGS:
            parts.append(
                (
                    f"possible artefacts ({', '.join(sorted(found & ARTIFACT_FLAGS))})",
                    "verify before interpreting a change",
                )
            )
        if parts:
            checks.append(
                Check(
                    code="target_flags",
                    severity="warn",
                    title=f"Target in {f.visit_label}: "
                    + "; ".join(p[0].split(" (")[0] for p in parts),
                    detail=" · ".join(f"{p[0]}: {p[1]}." for p in parts),
                )
            )

    # 6. PSF -------------------------------------------------------------------------
    if a.psf_fwhm_arcsec and b.psf_fwhm_arcsec:
        ratio = max(a.psf_fwhm_arcsec, b.psf_fwhm_arcsec) / min(
            a.psf_fwhm_arcsec, b.psf_fwhm_arcsec
        )
        if ratio > PSF_RATIO_WARN:
            checks.append(
                Check(
                    code="psf_mismatch",
                    severity="warn",
                    title=f"PSF widths differ by {ratio:.2f}×",
                    detail=f'{a.psf_fwhm_arcsec:.1f}" vs {b.psf_fwhm_arcsec:.1f}" FWHM: '
                    "bright stars leave ring-shaped residuals that are not real changes.",
                )
            )

    # 7. Noise -----------------------------------------------------------------------
    if a.noise_mjy_sr > 0 and b.noise_mjy_sr > 0:
        ratio = max(a.noise_mjy_sr, b.noise_mjy_sr) / min(a.noise_mjy_sr, b.noise_mjy_sr)
        if ratio > NOISE_RATIO_WARN:
            checks.append(
                Check(
                    code="noise_mismatch",
                    severity="info",
                    title=f"Noise levels differ by {ratio:.1f}×",
                    detail="The significance map accounts for each frame's variance.",
                )
            )

    # 8. Processing version ----------------------------------------------------------
    # Deep-field collections are the same release as their all-sky counterpart.
    rel_a = {c.removesuffix("_deep") for c in a.collections}
    rel_b = {c.removesuffix("_deep") for c in b.collections}
    if rel_a != rel_b:
        labels = lambda rels: ", ".join(describe(r)["label"] for r in sorted(rels))  # noqa: E731
        any_qr = any(describe(r)["kind"] == "qr" for r in rel_a | rel_b)
        checks.append(
            Check(
                code="mixed_releases",
                severity="info",
                title="Frames come from different data releases",
                detail=f"{labels(rel_a)} vs {labels(rel_b)}: different processing versions; "
                "small flux offsets are possible"
                + (" (quick-release calibration is preliminary)." if any_qr else "."),
            )
        )

    comparable = not any(c.severity == "fail" for c in checks)
    return comparable, checks
