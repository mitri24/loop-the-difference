// Mirrors backend/app/models.py
export interface Observation {
  obs_id: string
  detector: number
  wavelength_min_um: number
  wavelength_max_um: number
  mjd: number
  date: string
  access_url: string
  cloud_url?: string | null // the whole Level-2 file on AWS S3
  collection?: string | null // IRSA collection, e.g. spherex_qr3
  // IRSA's ObsCore metadata, null where it lists none (field comments: see Frame).
  exposure_s?: number | null
  start_mjd?: number | null
  end_mjd?: number | null
  spatial_resolution_arcsec?: number | null
  resolving_power?: number | null
  calib_level?: number | null
  publisher_did?: string | null
  instrument_name?: string | null
  facility_name?: string | null
  release_date?: string | null
  pixel_scale_arcsec?: number | null
}

export interface Epoch {
  start: string
  end: string
  count: number
}

export interface ObservationSummary {
  collection: string
  ra: number
  dec: number
  count: number
  detectors: Record<string, number>
  epochs: Epoch[]
  observations: Observation[]
}

export interface ProperMotion {
  source_id: string
  ra: number
  dec: number
  ref_epoch: number
  pmra_mas_yr: number
  pmdec_mas_yr: number
  parallax_mas: number | null
}

export interface ResolvedTarget {
  name: string
  ra: number
  dec: number
  proper_motion?: ProperMotion // left out when Gaia DR3 has no match
}

// A random fast-moving Gaia DR3 star; an example target (no motion fields) when Gaia is down.
export interface SurpriseTarget extends ResolvedTarget {
  pm_mas_yr?: number
  g_mag?: number
  reason: string
}

export interface Frame {
  index: number
  url: string
  obs_id: string
  date: string
  mjd: number
  detector: number
  wavelength_min_um: number
  wavelength_max_um: number
  coverage: number
  source_url: string
  cloud_url?: string | null // absent in manifests cached before NAS-54
  epoch: number
  n_combined: number
  date_end: string | null
  masked_fraction: number | null // share of the covered field without usable data
  wavelength_um: number | null
  bandwidth_um: number | null
  sources?: DetectedSource[]
  release?: string | null // "DR1", "QR3", "DR1 deep", or "DR1 + QR3" for a mixed stack
  // IRSA's ObsCore metadata; absent in manifests cached before pipeline 13. A stack adds up the exposure times,
  // spans the first start to the last end, names its first exposure by publisher_did (like obs_id), takes the last
  // release_date and keeps every other field only where all its exposures agree (else null).
  exposure_s?: number | null // t_exptime in s
  start_mjd?: number | null // t_min
  end_mjd?: number | null // t_max
  spatial_resolution_arcsec?: number | null // s_resolution
  resolving_power?: number | null // em_res_power, λ/Δλ
  calib_level?: number | null // ObsCore 0 raw … 2 calibrated, science-ready … 4 analysis product
  publisher_did?: string | null // IVOA ID, e.g. ivo://irsa.ipac/spherex_dr1?2025W19_1B_0116_1/D6
  instrument_name?: string | null
  facility_name?: string | null
  release_date?: string | null // when IRSA made the image public, ISO UTC
  pixel_scale_arcsec?: number | null // the detector's; the frame PNG has FrameManifest.pixel_scale_arcsec
}

export type CheckSeverity = 'error' | 'blocker' | 'warning' | 'info'

export interface Check {
  code: string
  severity: CheckSeverity
  message: string
  detail: string
  affects: string[]
}

export interface Difference {
  a: number
  b: number
  url: string
  comparable: boolean
  delta_lambda_pct: number | null
  obs_ids_a: string[]
  obs_ids_b: string[]
}

export interface FrameManifest {
  collection: string // comma-separated IRSA collections that were searched
  release?: string | null // releases of the frames shown, e.g. "DR1 + QR3"
  ra: number
  dec: number
  size_deg: number
  detector: number
  pixel_scale_arcsec: number
  epochs: number
  complete: boolean
  stacked: boolean
  preview?: boolean
  pipeline_version?: number
  frames: Frame[]
  warnings: string[]
  checks: Check[]
  differences: Difference[]
}

export interface FrameJob {
  job_id: string
  status: 'queued' | 'started' | 'finished' | 'failed' | 'not_found'
  progress: number
  total: number
  manifest: FrameManifest | null
  error: string | null
}

export interface FrameRequest {
  ra: string
  dec: string
  size_deg: number
  detector: number
  max_frames: number
  stack?: boolean
}

export interface SpectrumRequest {
  ra: string
  dec: string
}

export interface SpectrumPoint {
  obs_id: string
  date: string
  mjd: number
  detector: number
  epoch: number
  wavelength_um: number
  bandwidth_um: number
  flux_ujy: number
  flux_err_ujy: number
  flagged?: boolean
  source_url: string
}

export interface Spectrum {
  collection: string
  ra: number
  dec: number
  complete: boolean
  points: SpectrumPoint[]
  checks: Check[]
}

export interface SpectrumJob {
  job_id: string
  status: FrameJob['status']
  progress: number
  total: number
  spectrum: Spectrum | null
  error: string | null
}

// Sources detected in one frame (backend/app/sources.py); a match is a positional coincidence.
export type SourceMatch = 'gaia' | 'allwise' | 'none' | 'unknown'

export interface DetectedSource {
  ra: number
  dec: number
  // 0-based pixel centre in the frame PNG: x to the right, y down from the top row (north).
  x: number
  y: number
  // Fitted PSF height above the sky (saturated core: brightest usable rim pixel), and its S/N.
  peak_mjy_sr: number
  snr: number
  saturated?: boolean // placed by the rim of its masked core; absent before pipeline 12
  match: SourceMatch
  catalog_id: string | null
  separation_arcsec: number | null
  catalog_mag: number | null
  catalog_band: 'G' | 'W1' | null
}

// Known asteroids and comets per epoch from NASA/JPL SBIdent (backend/app/smallbodies.py).
export interface SmallBodiesRequest {
  ra: string
  dec: string
  size_deg: number
  mjds: number[]
}

export interface SmallBody {
  name: string
  ra: number
  dec: number
  vmag: number | null
  // Arcsec per hour; the RA rate is on the sky (dRA·cos dec).
  ra_rate: number
  dec_rate: number
  distance_arcsec: number
}

export interface SmallBodyEpoch {
  mjd: number
  date: string
  bodies: SmallBody[]
  error: string | null
  source_url: string
}

export interface SmallBodiesJob {
  job_id: string
  status: FrameJob['status']
  progress: number
  total: number
  epochs: SmallBodyEpoch[]
  error: string | null
}

export interface NeossatCoverage {
  collection: string
  ra: number
  dec: number
  count: number
  first_date: string | null
  last_date: string | null
  search_url: string
  note: string
}

export interface TrackMark {
  ra: string
  dec: string
  mjd: number
  sigma_arcsec?: number // default 1.5
}

export interface DistanceGrid {
  marks: [TrackMark, TrackMark] // 1.5 minutes to 400 days apart
  d_min_au?: number // default 20
  d_max_au?: number // default 2000
  steps?: number // default 64, uniform in 1/d
}

export interface DistantTrackRequest extends DistanceGrid {
  target_mjds: number[]
}

export interface TrackPoint {
  mjd: number
  ra: number
  dec: number
  radius_arcsec: number // 2σ search radius from the mark uncertainties alone
  model_error_arcsec?: number | null // how far a bound object can stray from the distance model
}

export interface DistanceHypothesis {
  distance_au: number
  points: TrackPoint[]
}

// Where the marked object would be for each assumed distance; not an orbit.
export interface DistantTrack {
  model: string
  assumptions: string[]
  hypotheses: DistanceHypothesis[]
}

// A straight-line position at one visit time (track.ts `predict`, stellar or fast regime).
export type FollowupPoint = TrackPoint

// A frame a mark was set on (pass Frame.obs_id, date, date_end): its visits are never measured,
// they would confirm the mark itself; a stack covers every visit from date to date_end.
export interface MarkedFrame {
  obs_id: string
  date?: string | null // ISO time with zone, e.g. Frame.date
  date_end?: string | null
}

// Forced photometry along a possible track at the other visits of one detector (backend/app/followup.py).
export interface FollowupRequest {
  ra: string // field whose visits are searched, e.g. the blink's centre
  dec: string
  detector: number
  marked: MarkedFrame[] // the marks' frames, one or two
  // Either the distance grid of two marks ...
  grid?: DistanceGrid | null
  // ... or one straight line at each visit time.
  points?: FollowupPoint[] | null
}

export interface FollowupMeasurement {
  obs_id: string
  date: string
  mjd: number
  // Predicted position and its 2σ search radius from the mark uncertainties alone.
  ra: number
  dec: number
  radius_arcsec: number
  model_error_arcsec: number // bound on the distance model's own error (orbits up to e = 0.5); 0 for a line
  position_uncertain: boolean // radius plus model error exceed the aperture radius; the flux still counts
  // Aperture flux without aperture correction (quick-look); null when skipped.
  flux_ujy: number | null
  flux_err_ujy: number | null
  snr: number | null
  // Total flux from the SPHEREx ePSF fitted at the same position; null without an ePSF or when skipped.
  psf_flux_ujy: number | null
  psf_flux_err_ujy: number | null
  psf_snr: number | null
  flagged: boolean // unusable pixels in the aperture: left out of the combination
  skipped: string | null // why there is no flux
  wavelength_um: number | null
  bandwidth_um: number | null
  source_url: string
}

export interface FollowupHypothesis {
  distance_au: number | null // null for a straight line
  // Inverse-variance weighted mean of the usable (unflagged) fluxes: PSF fluxes when psf_photometry.
  flux_ujy: number | null
  flux_err_ujy: number | null
  snr: number | null
  visits: number
  measurements: FollowupMeasurement[]
}

// Flux along a possible track combined per hypothesis: it tests a candidate, it never confirms one.
export interface Followup {
  collection: string
  ra: number
  dec: number
  detector: number
  model: string
  complete: boolean
  best: number | null // index into hypotheses: highest S/N over at least two visits
  significant: boolean // the best S/N reaches 5
  distance_determined: boolean // false: do not name a distance, the visits cannot tell them apart
  psf_photometry: boolean // the hypotheses combine PSF fluxes (every measured flux has one)
  hypotheses: FollowupHypothesis[]
  checks: Check[]
  // The best S/N corrected for trying independent_trials hypotheses (look-elsewhere), in σ; the local S/N itself for
  // one trial; null without a best hypothesis.
  global_sigma: number | null
  independent_trials: number // 0 without a hypothesis of two or more visits
  visits_total: number // visits of the detector in the track's window that could be measured (not the marks' own)
  visits_measured: number // of those, the ones that gave a flux
  not_covered_reasons: NotCoveredReason[] // why visits or predictions gave no usable flux, most actionable first
}

export interface FollowupJob {
  job_id: string
  status: FrameJob['status']
  progress: number
  total: number
  followup: Followup | null
  error: string | null
}

// Why a follow-up measured fewer visits (backend/app/models.py NotCoveredReason; the FOLLOWUP_* checks say it in words).
export type NotCoveredReason =
  | 'outside_image' // prediction outside the visit's image
  | 'search_circle_too_wide' // 2σ search circle wider than the aperture's diameter
  | 'model_error_too_large' // the distance model can be off by more than that
  | 'image_edge' // prediction at the edge of the cutout
  | 'flagged_pixels' // flagged pixels in the aperture: flux left out
  | 'cutout_missing' // the archive did not deliver a readable cutout
  | 'search_unanswered' // an archive search where the track leaves the field got no answer
  | 'release_unavailable' // a SPHEREx release could not be searched
  | 'no_flux' // NaN pixels, too few sky pixels or invalid VARIANCE
  | 'thinned' // left out to stay within the cutout budget
  | 'not_searched' // more positions outside the field's images than searches per job
  | 'beyond_window' // visits more than 400 days from the marks
  | 'no_prediction' // straight line: no position sent for the visit
  | 'unmatched_prediction' // straight line: a position matches no visit

// One track of a follow-up in the visits of every detector (backend/app/fingerprint.py): the follow-up's request plus
// distance_au (its best distance) for a grid; straight-line points at the visit times of every detector.
export interface FingerprintRequest extends FollowupRequest {
  distance_au?: number | null
}

export type SpectralWindowCode = 'h_peak' | 'ch4_1.7' | 'k_peak' | 'ch4_2.25' | 'ch4_3.3' | 'peak_4um'

// A wavelength window of the methane index: a CH₄ band or a flux peak that serves as its continuum.
export interface SpectralWindow {
  code: SpectralWindowCode
  name: string
  lo_um: number
  hi_um: number
  kind: 'band' | 'continuum'
}

// One visit's flux along the track in any detector; wavelength_um from its cutout's WCS-WAVE table.
export interface FingerprintPoint extends FollowupMeasurement {
  detector: number
  planned_wavelength_um: number | null // expected from where the track crosses the visit's image, before download
  window: SpectralWindowCode | null // window of the methane index the measured wavelength lies in
}

export interface MethaneBand {
  band: SpectralWindowCode
  continuum: SpectralWindowCode[] // blue and red continuum window
  status: 'measured' | 'not_enough_channels' | 'continuum_too_faint'
  points: number // usable visits in the band
  continuum_points: number[] // and in each continuum window
  flux_ujy: number | null // weighted mean in the band (PSF totals)
  continuum_ujy: number | null // the power law through the continuum windows, at the band
  depth: number | null // 1 − band / continuum
  depth_err: number | null
  sigma: number | null // how far the band lies below the continuum
}

// CH₄ absorption along the track: a reason to look closer, never an identification.
export interface MethaneIndex {
  verdict: 'absorption' | 'hint' | 'none' | 'not_enough_channels' | 'continuum_too_faint' | 'no_total_flux'
  sigma: number | null // the bands combined, shared continuum windows taken into account
  summary: string // one line, e.g. "CH₄ absorption 3.8σ – as in T/Y brown dwarfs or a cold giant planet; …"
  bands: MethaneBand[]
}

// Quick-look spectrum of one possible track from the visits of every detector.
export interface Fingerprint {
  collection: string
  ra: number
  dec: number
  detector: number // the marks' detector
  model: string
  distance_au: number | null // null for a straight line
  complete: boolean
  psf_photometry: boolean // the spectrum uses psf_flux_ujy; false: aperture flux_ujy, no total, no index
  visits_total: number
  visits_measured: number
  windows: SpectralWindow[]
  points: FingerprintPoint[] // by wavelength, visits without one last
  methane: MethaneIndex
  checks: Check[]
}

export interface FingerprintJob {
  job_id: string
  status: FrameJob['status']
  progress: number
  total: number
  fingerprint: Fingerprint | null
  error: string | null
}
