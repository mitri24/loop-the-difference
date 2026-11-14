// Mirrors backend/app/models.py
export interface Observation {
  obs_id: string
  detector: number
  wavelength_min_um: number
  wavelength_max_um: number
  mjd: number
  date: string
  access_url: string
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
  epoch: number
  n_combined: number
  date_end: string | null
  masked_fraction: number | null
  wavelength_um: number | null
  bandwidth_um: number | null
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
