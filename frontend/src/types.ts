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
  masked_fraction: number | null
  wavelength_um: number | null
  bandwidth_um: number | null
  sources?: DetectedSource[]
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
  collection: string
  ra: number
  dec: number
  size_deg: number
  detector: number
  pixel_scale_arcsec: number
  epochs: number
  complete: boolean
  stacked: boolean
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
  peak_mjy_sr: number
  snr: number
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
