from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class Observation(BaseModel):
    obs_id: str
    detector: int
    wavelength_min_um: float
    wavelength_max_um: float
    mjd: float
    date: str
    access_url: str
    # The whole Level-2 file on AWS S3 (anonymous HTTPS), when IRSA lists a cloud copy.
    cloud_url: str | None = None
    # The IRSA collection the observation was found in, e.g. spherex_qr3.
    collection: str | None = None
    # The image's footprint as IRSA gives it (s_region, e.g. "POLYGON ICRS ..."); server only.
    s_region: str | None = Field(default=None, exclude=True)
    # IRSA's ObsCore metadata, None where it lists none: exposure time (t_exptime), start and end
    # of the exposure (t_min, t_max), angular resolution (s_resolution), λ/Δλ (em_res_power),
    # calibration level (2: calibrated, science-ready), IVOA publisher ID (obs_publisher_did),
    # the date IRSA made the image public (obs_release_date, ISO UTC) and the detector's pixel
    # scale (s_pixel_scale).
    exposure_s: float | None = None
    start_mjd: float | None = None
    end_mjd: float | None = None
    spatial_resolution_arcsec: float | None = None
    resolving_power: float | None = None
    calib_level: int | None = None
    publisher_did: str | None = None
    instrument_name: str | None = None
    facility_name: str | None = None
    release_date: str | None = None
    pixel_scale_arcsec: float | None = None


class Epoch(BaseModel):
    start: str
    end: str
    count: int


class ObservationSummary(BaseModel):
    collection: str
    ra: float
    dec: float
    count: int
    detectors: dict[int, int]
    epochs: list[Epoch]
    observations: list[Observation]


class ProperMotion(BaseModel):
    """Gaia DR3 astrometry: position at ref_epoch (Julian year), pmra includes cos(dec)."""

    source_id: str
    ra: float
    dec: float
    ref_epoch: float
    pmra_mas_yr: float
    pmdec_mas_yr: float
    parallax_mas: float | None


class ResolvedTarget(BaseModel):
    name: str
    ra: float
    dec: float
    proper_motion: ProperMotion | None = None


class FrameRequest(BaseModel):
    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)
    size_deg: float = Field(default=0.2, gt=0, le=1.0)
    detector: int = Field(default=6, ge=1, le=6)
    max_frames: int = Field(default=12, ge=2, le=24)
    stack: bool = False


class Frame(BaseModel):
    index: int
    url: str
    obs_id: str
    date: str
    mjd: float
    detector: int
    wavelength_min_um: float
    wavelength_max_um: float
    coverage: float
    source_url: str
    cloud_url: str | None = None
    epoch: int = 0
    n_combined: int = 1
    date_end: str | None = None
    # Share of the covered field without usable data (flagged pixels after resampling and stacking).
    masked_fraction: float | None = None
    wavelength_um: float | None = None
    bandwidth_um: float | None = None
    sources: list["DetectedSource"] = []
    # SPHEREx release of the frame's exposures: "DR1", "QR3", "DR1 deep", or "DR1 + QR3".
    release: str | None = None
    # The exposures' ObsCore metadata (Observation). A stack adds up their exposure times, spans
    # the first start to the last end, names its first exposure by publisher_did (like obs_id),
    # takes the last release_date and keeps every other field only where all exposures agree.
    # pixel_scale_arcsec is the detector's; the frame PNG has FrameManifest.pixel_scale_arcsec.
    exposure_s: float | None = None
    start_mjd: float | None = None
    end_mjd: float | None = None
    spatial_resolution_arcsec: float | None = None
    resolving_power: float | None = None
    calib_level: int | None = None
    publisher_did: str | None = None
    instrument_name: str | None = None
    facility_name: str | None = None
    release_date: str | None = None
    pixel_scale_arcsec: float | None = None


class Check(BaseModel):
    code: str
    severity: Literal["error", "blocker", "warning", "info"]
    message: str
    detail: str = ""
    affects: list[str] = []


class Difference(BaseModel):
    a: int
    b: int
    url: str
    comparable: bool
    delta_lambda_pct: float | None = None
    obs_ids_a: list[str] = []
    obs_ids_b: list[str] = []


class FrameManifest(BaseModel):
    # Comma-separated IRSA collections that were searched.
    collection: str
    # Releases of the frames shown, e.g. "DR1 + QR3".
    release: str | None = None
    ra: float
    dec: float
    size_deg: float
    detector: int
    pixel_scale_arcsec: float
    epochs: int
    # False when the archive did not deliver every frame: the next request retries.
    complete: bool = True
    stacked: bool = False
    preview: bool = False
    # Manifests written before this field existed come from pipeline version 1.
    pipeline_version: int = 1
    frames: list[Frame]
    # Human-readable copy of the checks' details, kept for older clients.
    warnings: list[str]
    checks: list[Check] = []
    differences: list[Difference] = []


class FrameJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    manifest: FrameManifest | None = None
    error: str | None = None


class SpectrumRequest(BaseModel):
    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)


class SpectrumPoint(BaseModel):
    obs_id: str
    date: str
    mjd: float
    detector: int
    epoch: int
    wavelength_um: float
    bandwidth_um: float
    # Background-subtracted aperture flux at the target (quick-look), corrected to total flux with
    # the ePSF when every cutout carries one (the QUICK_LOOK_SPECTRUM check says which).
    flux_ujy: float
    flux_err_ujy: float
    # Pixels the archive marks unusable lie in the aperture: the flux is unreliable.
    flagged: bool = False
    source_url: str


class Spectrum(BaseModel):
    collection: str
    ra: float
    dec: float
    complete: bool = True
    points: list[SpectrumPoint]
    checks: list[Check] = []


class SpectrumJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    spectrum: Spectrum | None = None
    error: str | None = None


class DetectedSource(BaseModel):
    """A point source at least 5σ above the noise in one frame (app/sources.py).

    `match` names the catalogue with a source within the match radius: a positional
    coincidence, not an identification. "none" needs verification; "unknown" means a catalogue
    did not answer.
    """

    ra: float
    dec: float
    # 0-based pixel centre in the frame PNG: x to the right (east is left), y down from the top
    # row (north is up). ra/dec are the reliable fields.
    x: float
    y: float
    # Height of the PSF fitted at the source above the sky (for a saturated core its brightest
    # usable rim pixel, a lower limit), and its significance in the frame's S/N map.
    peak_mjy_sr: float
    snr: float
    # Placed by the rim of a masked core too large for a PSF fit: good to about 2.5″ per axis.
    saturated: bool = False
    match: Literal["gaia", "allwise", "none", "unknown"]
    catalog_id: str | None = None
    separation_arcsec: float | None = None
    # Vega magnitude in catalog_band: Gaia DR3 G or AllWISE W1.
    catalog_mag: float | None = None
    catalog_band: Literal["G", "W1"] | None = None


Frame.model_rebuild()
FrameManifest.model_rebuild()
FrameJob.model_rebuild()


# One time per epoch; 1995–2077, because SBIdent times out for dates decades back.
SmallBodyMjd = Annotated[float, Field(ge=50000, le=80000)]


class SmallBodiesRequest(BaseModel):
    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)
    size_deg: float = Field(default=0.2, gt=0, le=1.0)
    mjds: list[SmallBodyMjd] = Field(min_length=1, max_length=6)


class SmallBody(BaseModel):
    """Known asteroid or comet from NASA/JPL SBIdent, seen from SPHEREx or else the geocentre."""

    name: str
    ra: float
    dec: float
    vmag: float | None = None
    # Apparent motion in arcsec per hour; the RA rate is on the sky (dRA·cos dec).
    ra_rate: float
    dec_rate: float
    # Separation from the field centre.
    distance_arcsec: float


class SmallBodyEpoch(BaseModel):
    mjd: float
    date: str
    bodies: list[SmallBody] = []
    error: str | None = None
    # The SBIdent request itself, so every listed body can be checked at the source. Its observer
    # is SPHEREx's position at `mjd` (xobs) or, without one, the geocentre (mpc-code=500).
    source_url: str


class SmallBodiesJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    epochs: list[SmallBodyEpoch] = []
    error: str | None = None


class NeossatCoverage(BaseModel):
    """NEOSSat (CSA) sky frames covering a position, counted at CADC: visible light, not SPHEREx."""

    collection: str
    ra: float
    dec: float
    count: int
    first_date: str | None = None
    last_date: str | None = None
    search_url: str
    note: str


class TrackMark(BaseModel):
    """One user mark of a moving object: position, frame time and position uncertainty."""

    model_config = ConfigDict(allow_inf_nan=False)

    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)
    mjd: float = Field(ge=50000, le=80000)
    sigma_arcsec: float = Field(default=1.5, ge=0.1, le=30)


# The distance model is used at most this long before and after the marks.
TRACK_WINDOW_DAYS = 400


class DistanceGrid(BaseModel):
    """Two marks of one moving object and the distances to assume for it, uniform in 1/d."""

    model_config = ConfigDict(allow_inf_nan=False)

    marks: list[TrackMark] = Field(min_length=2, max_length=2)
    d_min_au: float = Field(default=20, ge=5)
    d_max_au: float = Field(default=2000, le=100000)
    steps: int = Field(default=64, ge=2, le=96)

    @model_validator(mode="after")
    def _check_grid(self) -> "DistanceGrid":
        t1, t2 = (mark.mjd for mark in self.marks)
        if not 0.001 <= abs(t2 - t1) <= TRACK_WINDOW_DAYS:
            raise ValueError(
                f"The two marks must be between 1.5 minutes and {TRACK_WINDOW_DAYS} days apart"
            )
        if self.d_max_au <= self.d_min_au:
            raise ValueError("d_max_au must be larger than d_min_au")
        return self


class DistantTrackRequest(DistanceGrid):
    target_mjds: list[float] = Field(min_length=1, max_length=24)

    @model_validator(mode="after")
    def _check_times(self) -> "DistantTrackRequest":
        t1, t2 = (mark.mjd for mark in self.marks)
        if any(max(abs(t - t1), abs(t - t2)) > TRACK_WINDOW_DAYS for t in self.target_mjds):
            raise ValueError(
                f"Every target time must be within {TRACK_WINDOW_DAYS} days of the marks"
            )
        return self


class TrackPoint(BaseModel):
    mjd: float
    ra: float
    dec: float
    # 2σ search radius from the mark uncertainties alone.
    radius_arcsec: float
    # How far a bound object can stray from the distance model here (tracks.model_error).
    model_error_arcsec: float | None = None


class DistanceHypothesis(BaseModel):
    distance_au: float
    points: list[TrackPoint]


class DistantTrack(BaseModel):
    """Where the marked object would be at other times for each assumed distance; not an orbit."""

    model: str
    assumptions: list[str]
    hypotheses: list[DistanceHypothesis]


class FollowupPoint(TrackPoint):
    """A straight-line prediction at one visit time, computed by the client (track.ts)."""

    model_config = ConfigDict(allow_inf_nan=False)

    mjd: float = Field(ge=50000, le=80000)
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    radius_arcsec: float = Field(ge=0)


class MarkedFrame(BaseModel):
    """A frame a mark was set on: its visits would confirm the mark itself, so none is measured."""

    obs_id: str = Field(min_length=1, max_length=80)
    # A stacked frame: every visit from its first exposure's date to its last one's.
    date: AwareDatetime | None = None
    date_end: AwareDatetime | None = None


class FollowupRequest(BaseModel):
    """A possible track to measure at the other SPHEREx visits of one detector (app/followup.py)."""

    model_config = ConfigDict(allow_inf_nan=False)

    # The field whose visits are searched, e.g. the blink's centre.
    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)
    detector: int = Field(ge=1, le=6)
    marked: list[MarkedFrame] = Field(min_length=1, max_length=2)
    # Either the distance hypotheses of two marks (tracks.py) ...
    grid: DistanceGrid | None = None
    # ... or one straight line (stellar or fast regime): its position at each visit time.
    points: list[FollowupPoint] | None = Field(default=None, min_length=1, max_length=1000)

    @model_validator(mode="after")
    def _one_track(self) -> "FollowupRequest":
        if (self.grid is None) == (self.points is None):
            raise ValueError("Give either a distance grid or straight-line points")
        return self


class FollowupMeasurement(BaseModel):
    """Forced aperture and PSF photometry at the predicted position in one visit (quick-look)."""

    obs_id: str
    date: str
    mjd: float
    # Predicted position and its 2σ search radius from the mark uncertainties alone.
    ra: float
    dec: float
    radius_arcsec: float
    # Bound on the distance model's own error (orbits up to e = 0.5); 0 for a straight line.
    model_error_arcsec: float = 0.0
    # Search radius plus model error exceed the aperture radius: the flux still counts.
    position_uncertain: bool = False
    # Background-subtracted aperture flux without aperture correction; None when skipped.
    flux_ujy: float | None = None
    flux_err_ujy: float | None = None
    snr: float | None = None
    # Total flux from the SPHEREx ePSF fitted at the same position (photometry.psf_photometry);
    # None without an ePSF or when skipped.
    psf_flux_ujy: float | None = None
    psf_flux_err_ujy: float | None = None
    psf_snr: float | None = None
    # Pixels the archive marks unusable lie in the aperture: left out of the combination.
    flagged: bool = False
    # Why there is no flux, e.g. "target at the cutout edge".
    skipped: str | None = None
    wavelength_um: float | None = None
    bandwidth_um: float | None = None
    source_url: str


class FollowupHypothesis(BaseModel):
    # Assumed distance from Earth at the first mark; None for a straight line.
    distance_au: float | None = None
    # Inverse-variance weighted mean of the usable (unflagged) fluxes and its 1σ error: PSF fluxes
    # when Followup.psf_photometry, else aperture fluxes.
    flux_ujy: float | None = None
    flux_err_ujy: float | None = None
    snr: float | None = None
    visits: int = 0
    measurements: list[FollowupMeasurement] = []


# Why visits or predictions of a follow-up were not measured or gave no usable flux, most
# actionable first (app/followup.py counts them; the FOLLOWUP_* checks say the same in words).
NotCoveredReason = Literal[
    "outside_image",  # prediction outside the visit's image (s_region)
    "search_circle_too_wide",  # 2σ search circle wider than the aperture's diameter
    "model_error_too_large",  # the distance model can be off by more than that
    "image_edge",  # prediction at the edge of the cutout
    "flagged_pixels",  # pixels the archive marks unusable in the aperture: flux left out
    "cutout_missing",  # the archive did not deliver a readable cutout
    "search_unanswered",  # an archive search where the track leaves the field got no answer
    "release_unavailable",  # a SPHEREx release could not be searched
    "no_flux",  # NaN pixels, too few sky pixels or invalid VARIANCE at the prediction
    "thinned",  # left out to stay within the cutout budget
    "not_searched",  # more positions outside the field's images than searches per job
    "beyond_window",  # visits more than TRACK_WINDOW_DAYS from the marks
    "no_prediction",  # straight line: the client sent no position for the visit
    "unmatched_prediction",  # straight line: a position matches no visit
]


class Followup(BaseModel):
    """Flux where a possible track puts the object at other visits, combined per hypothesis
    (shift-and-stack): it tests a candidate, it never confirms one."""

    collection: str
    ra: float
    dec: float
    detector: int
    model: str
    complete: bool = True
    # Index into hypotheses of the highest S/N over at least two visits.
    best: int | None = None
    # The best S/N reaches 5: a candidate worth checking, not a detection.
    significant: bool = False
    # Some measured visit sees the tested distances an aperture or more apart.
    distance_determined: bool = False
    # Every measured flux has a PSF flux too, so the hypotheses combine those (totals, higher S/N).
    psf_photometry: bool = False
    hypotheses: list[FollowupHypothesis] = []
    checks: list[Check] = []
    # The best S/N as the significance of the best of independent_trials tries (look-elsewhere,
    # one-sided Šidák), in σ; the local S/N itself for one trial; None without a best hypothesis.
    global_sigma: float | None = None
    # Independent hypotheses among those with two or more visits: groups an aperture apart at the
    # visit that separates most of them (0 without any such hypothesis).
    independent_trials: int = 0
    # Visits of the detector in the track's window that could be measured (the marks' own visits
    # and other releases' copies not counted), and those of them that gave a flux.
    visits_total: int = 0
    visits_measured: int = 0
    not_covered_reasons: list[NotCoveredReason] = []


class FollowupJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    followup: Followup | None = None
    error: str | None = None


class FingerprintRequest(FollowupRequest):
    """One track of a follow-up measured in the visits of every detector (app/fingerprint.py).

    The follow-up's request with distance_au, the distance to measure at (its best), for a grid;
    straight-line points then at the visit times of every detector. detector stays the marks'
    one: only its visits that made the marks are left out.
    """

    distance_au: float | None = Field(default=None, ge=5, le=100000)

    @model_validator(mode="after")
    def _one_distance(self) -> "FingerprintRequest":
        if self.grid is None:
            if self.distance_au is not None:
                raise ValueError("distance_au needs a distance grid, not straight-line points")
            return self
        if self.distance_au is None:
            raise ValueError("Give distance_au, the distance to measure the spectrum at")
        if not self.grid.d_min_au <= self.distance_au <= self.grid.d_max_au:
            raise ValueError("distance_au must lie between the grid's d_min_au and d_max_au")
        return self


# Wavelength windows of the methane index (app/fingerprint.py WINDOWS).
SpectralWindowCode = Literal["h_peak", "ch4_1.7", "k_peak", "ch4_2.25", "ch4_3.3", "peak_4um"]


class SpectralWindow(BaseModel):
    code: SpectralWindowCode
    name: str
    lo_um: float
    hi_um: float
    # A CH₄ band, or a flux peak between bands that serves as its continuum.
    kind: Literal["band", "continuum"]


class FingerprintPoint(FollowupMeasurement):
    """One visit's flux along the track in any detector; wavelength_um from its WCS-WAVE table."""

    detector: int
    # The wavelength expected from where the track crosses the visit's image, before downloading.
    planned_wavelength_um: float | None = None
    # The window of the methane index the measured wavelength lies in.
    window: SpectralWindowCode | None = None


class MethaneBand(BaseModel):
    """One CH₄ band against the power law through a continuum window on either side."""

    band: SpectralWindowCode
    continuum: list[SpectralWindowCode]
    status: Literal["measured", "not_enough_channels", "continuum_too_faint"]
    # Usable visits in the band and in each continuum window.
    points: int = 0
    continuum_points: list[int] = []
    # Weighted mean flux in the band and the continuum there (µJy, PSF totals).
    flux_ujy: float | None = None
    continuum_ujy: float | None = None
    # 1 − band / continuum with its 1σ error, and how far the band lies below the continuum in σ.
    depth: float | None = None
    depth_err: float | None = None
    sigma: float | None = None


class MethaneIndex(BaseModel):
    """CH₄ absorption along the track: a reason to look closer, never an identification."""

    verdict: Literal[
        "absorption", "hint", "none", "not_enough_channels", "continuum_too_faint", "no_total_flux"
    ]
    # The bands combined, their shared continuum windows taken into account; None without a band.
    sigma: float | None = None
    # One line for the UI, e.g. "CH₄ absorption 3.8σ – as in T/Y brown dwarfs or a cold giant …".
    summary: str
    bands: list[MethaneBand] = []


class Fingerprint(BaseModel):
    """Quick-look spectrum of one possible track from the visits of every detector."""

    collection: str
    ra: float
    dec: float
    # The marks' detector.
    detector: int
    model: str
    # The distance measured at; None for a straight line.
    distance_au: float | None = None
    complete: bool = True
    # Every measured flux has a PSF flux: the spectrum and the index use psf_flux_ujy, else the
    # points' aperture flux_ujy, which is no total and gives no index.
    psf_photometry: bool = False
    # Visits of every detector in the track's window that could be measured, and with a flux.
    visits_total: int = 0
    visits_measured: int = 0
    windows: list[SpectralWindow] = []
    # Sorted by wavelength; visits without one last.
    points: list[FingerprintPoint] = []
    methane: MethaneIndex
    checks: list[Check] = []


class FingerprintJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    fingerprint: Fingerprint | None = None
    error: str | None = None
