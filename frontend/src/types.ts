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

export interface ResolvedTarget {
  name: string
  ra: number
  dec: number
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
