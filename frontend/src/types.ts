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
}

export interface FollowupJob {
  job_id: string
  status: FrameJob['status']
  progress: number
  total: number
  followup: Followup | null
  error: string | null
}
