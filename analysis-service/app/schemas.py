"""Pydantic models shared by the API. Mirrored by hand in ``frontend/src/api/types.ts``
(keep both in sync; see SKILLS.md → "Change an API contract")."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["ok", "info", "warn", "fail"]


class Check(BaseModel):
    """One evidence/comparability check shown in the UI evidence panel."""

    code: str
    severity: Severity
    title: str
    detail: str


class Target(BaseModel):
    name: str | None = None
    ra: float = Field(description="ICRS RA (deg) at the catalogue epoch")
    dec: float = Field(description="ICRS Dec (deg) at the catalogue epoch")
    epoch_jyear: float = 2000.0
    pm_ra_mas_yr: float | None = Field(None, description="pmRA*cos(dec), mas/yr")
    pm_dec_mas_yr: float | None = None
    source: str = "user"


class Observation(BaseModel):
    """One SPHEREx spectral image (one detector, one exposure) covering the target."""

    obs_publisher_did: str
    obs_id: str
    collection: str
    band: str
    detector: int
    mjd: float
    date_utc: str
    exptime_s: float
    access_url: str
    s_region: str
    em_min_um: float
    em_max_um: float
    resolving_power: float
    release_date: str | None = None
    # Estimated before download from the footprint + WCS-WAVE lookup:
    lambda_est_um: float | None = None
    bandwidth_est_um: float | None = None
    detector_xy_est: tuple[float, float] | None = None
    fov_coverage: float = 1.0
    visit: int = 0


class Visit(BaseModel):
    index: int
    label: str
    mjd_start: float
    mjd_end: float
    n_observations: int


class ObservationSearch(BaseModel):
    target: Target
    ra_epoch: float
    dec_epoch: float
    epoch_jyear: float
    fov_arcmin: float
    collections: list[str]
    observations: list[Observation]
    visits: list[Visit]
    checks: list[Check]
    query_urls: list[str]


class Frame(BaseModel):
    """An aligned image on the common grid (single exposure or a per-visit stack)."""

    id: str
    kind: Literal["single", "stack"]
    band: str
    visit: int
    visit_label: str
    mjd: float
    mjd_start: float
    mjd_end: float
    date_utc: str
    lambda_um: float
    lambda_min_um: float
    lambda_max_um: float
    bandwidth_um: float | None = None
    n_exposures: int
    obs_ids: list[str]
    source_urls: list[str]
    collections: list[str]
    flags_at_target: list[str]
    hard_flag_fraction: float
    coverage: float
    psf_fwhm_arcsec: float | None = None
    background_mjy_sr: float
    noise_mjy_sr: float
    png_url: str
    fits_url: str
    target_px: tuple[float, float]


class GridInfo(BaseModel):
    ra: float
    dec: float
    npix: int
    pixel_arcsec: float
    fov_arcmin: float
    wcs_header: dict[str, float | str]


class SequenceRequest(BaseModel):
    ra: str | float
    dec: str | float
    name: str | None = None
    pm_ra_mas_yr: float | None = None
    pm_dec_mas_yr: float | None = None
    target_epoch_jyear: float = 2000.0
    band: str = "D1"
    fov_arcmin: float | None = None
    mode: Literal["stack", "matched", "all"] = "stack"
    reference_lambda_um: float | None = None
    stretch: Literal["per_frame", "shared"] = "per_frame"


class SequenceResult(BaseModel):
    grid: GridInfo
    band: str
    mode: str
    frames: list[Frame]
    checks: list[Check]
    failed: list[dict[str, str]]


class DifferenceRequest(BaseModel):
    frame_a: str
    frame_b: str
    force: bool = False


class Residual(BaseModel):
    x: float
    y: float
    ra: float
    dec: float
    significance: float
    explanation: str
    known_source: str | None = None
    kind: Literal[
        "moving_star", "bright_star", "known_source", "red_source", "solar_system", "unknown"
    ] = "unknown"


class SolarSystemMarker(BaseModel):
    """A known asteroid/comet inside the field, in display pixels, at epoch A or B."""

    name: str
    epoch: Literal["A", "B"]
    x: float
    y: float
    vmag: float | None = None
    date_utc: str


class DifferenceResult(BaseModel):
    id: str
    frame_a: str
    frame_b: str
    comparable: bool
    png_url: str
    significance_png_url: str
    checks: list[Check]
    residuals: list[Residual]
    delta_days: float
    delta_lambda_um: float
    solar_system: list[SolarSystemMarker] | None = None  # None = not checked yet


class SpectrumPoint(BaseModel):
    obs_id: str
    band: str
    visit: int
    mjd: float
    lambda_um: float
    bandwidth_um: float
    flux_mjy: float
    flux_err_mjy: float
    flags: list[str]
    quality: Literal["good", "degraded", "bad"]
    usable: bool
    source_url: str


class SpectrumResult(BaseModel):
    target_ra: float
    target_dec: float
    aperture_arcsec: float
    points: list[SpectrumPoint]
    checks: list[Check]
    failed: list[dict[str, str]]


class CatalogSource(BaseModel):
    catalog: str
    id: str
    ra: float
    dec: float
    mag: float | None = None
    mag_band: str | None = None
    pm_ra_mas_yr: float | None = None
    pm_dec_mas_yr: float | None = None
    epoch_jyear: float


class CadcImage(BaseModel):
    """One image of the target field from another telescope, held at the CADC (Canada)."""

    collection: str
    observation_id: str
    instrument: str | None = None
    target_name: str | None = None
    band: str | None = None
    mjd: float | None = None
    date_utc: str | None = None
    exptime_s: float | None = None
    calibration_level: int | None = None
    thumbnail_url: str | None = None
    files_url: str  # CADC DataLink: every file of this image (FITS, previews)
    proprietary: bool = False


class CadcCollection(BaseModel):
    """All images of one archive collection (telescope/mission) covering the field."""

    collection: str
    label: str
    canadian: bool
    n_images: int
    first_date: str | None = None
    last_date: str | None = None
    bands: list[str]
    instruments: list[str]
    images: list[CadcImage]  # most recent first, those with a preview first


class CadcSearch(BaseModel):
    ra: float
    dec: float
    radius_arcmin: float
    n_images: int
    collections: list[CadcCollection]
    truncated: bool
    excluded_collections: list[str]
    query_url: str
    search_url: str
    checks: list[Check]


class SolarSystemObject(BaseModel):
    """Known asteroid/comet position from JPL SBIdent at one instant (geocentric)."""

    name: str
    ra: float
    dec: float
    vmag: float | None = None
    ra_rate_arcsec_h: float = 0.0
    dec_rate_arcsec_h: float = 0.0
    mjd: float


class JobStatus(BaseModel):
    id: str
    kind: str
    state: Literal["queued", "running", "done", "error"]
    progress: float
    message: str
    result: SequenceResult | SpectrumResult | DifferenceResult | CadcSearch | None = None
    error: str | None = None
