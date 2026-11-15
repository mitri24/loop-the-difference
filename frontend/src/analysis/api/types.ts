// Mirror of backend/app/schemas.py. Keep in sync by hand (SKILLS.md → "Change an API
// contract"). Pixel coordinates (*_px, residual x/y) are DISPLAY pixels: origin top-left
// of the PNG, north up, east left.

export type Severity = "ok" | "info" | "warn" | "fail";
export type BandName = "D1" | "D2" | "D3" | "D4" | "D5" | "D6";
export type Mode = "stack" | "matched" | "all";

export interface Check {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface Target {
  name: string | null;
  ra: number;
  dec: number;
  epoch_jyear: number;
  pm_ra_mas_yr: number | null;
  pm_dec_mas_yr: number | null;
  source: string;
}

export interface Observation {
  obs_publisher_did: string;
  obs_id: string;
  collection: string;
  band: BandName;
  detector: number;
  mjd: number;
  date_utc: string;
  exptime_s: number;
  access_url: string;
  s_region: string;
  em_min_um: number;
  em_max_um: number;
  resolving_power: number;
  release_date: string | null;
  lambda_est_um: number | null;
  bandwidth_est_um: number | null;
  detector_xy_est: [number, number] | null;
  fov_coverage: number;
  visit: number;
}

export interface Visit {
  index: number;
  label: string;
  mjd_start: number;
  mjd_end: number;
  n_observations: number;
}

export interface ObservationSearch {
  target: Target;
  ra_epoch: number;
  dec_epoch: number;
  epoch_jyear: number;
  fov_arcmin: number;
  collections: string[];
  observations: Observation[];
  visits: Visit[];
  checks: Check[];
  query_urls: string[];
}

export interface Frame {
  id: string;
  kind: "single" | "stack";
  band: BandName;
  visit: number;
  visit_label: string;
  mjd: number;
  mjd_start: number;
  mjd_end: number;
  date_utc: string;
  lambda_um: number;
  lambda_min_um: number;
  lambda_max_um: number;
  bandwidth_um: number | null;
  n_exposures: number;
  obs_ids: string[];
  source_urls: string[];
  collections: string[];
  flags_at_target: string[];
  hard_flag_fraction: number;
  coverage: number;
  psf_fwhm_arcsec: number | null;
  background_mjy_sr: number;
  noise_mjy_sr: number;
  png_url: string;
  fits_url: string;
  target_px: [number, number];
}

export interface GridInfo {
  ra: number;
  dec: number;
  npix: number;
  pixel_arcsec: number;
  fov_arcmin: number;
  wcs_header: Record<string, number | string>;
}

export interface SequenceRequest {
  ra: string | number;
  dec: string | number;
  name?: string | null;
  pm_ra_mas_yr?: number | null;
  pm_dec_mas_yr?: number | null;
  target_epoch_jyear?: number;
  band: BandName;
  fov_arcmin?: number;
  mode: Mode;
  reference_lambda_um?: number | null;
  stretch?: "per_frame" | "shared";
}

export interface SequenceResult {
  grid: GridInfo;
  band: BandName;
  mode: Mode;
  frames: Frame[];
  checks: Check[];
  failed: Record<string, string>[];
}

export interface Residual {
  x: number;
  y: number;
  ra: number;
  dec: number;
  significance: number;
  explanation: string;
  known_source: string | null;
  kind: ResidualKind;
}

export type ResidualKind =
  | "moving_star"
  | "bright_star"
  | "known_source"
  | "red_source"
  | "solar_system"
  | "unknown";

export interface SolarSystemMarker {
  name: string;
  epoch: "A" | "B";
  x: number;
  y: number;
  vmag: number | null;
  date_utc: string;
}

export interface DifferenceResult {
  id: string;
  frame_a: string;
  frame_b: string;
  comparable: boolean;
  png_url: string;
  significance_png_url: string;
  checks: Check[];
  residuals: Residual[];
  delta_days: number;
  delta_lambda_um: number;
  /** null until the JPL known asteroid/comet check has run */
  solar_system: SolarSystemMarker[] | null;
}

export interface SpectrumPoint {
  obs_id: string;
  band: BandName;
  visit: number;
  mjd: number;
  lambda_um: number;
  bandwidth_um: number;
  flux_mjy: number;
  flux_err_mjy: number;
  flags: string[];
  quality: "good" | "degraded" | "bad";
  usable: boolean;
  source_url: string;
}

export interface SpectrumResult {
  target_ra: number;
  target_dec: number;
  aperture_arcsec: number;
  points: SpectrumPoint[];
  checks: Check[];
  failed: Record<string, string>[];
}

/** An image of the field from another telescope, held at the CADC (Canada). */
export interface CadcImage {
  collection: string;
  observation_id: string;
  instrument: string | null;
  target_name: string | null;
  band: string | null;
  mjd: number | null;
  date_utc: string | null;
  exptime_s: number | null;
  calibration_level: number | null;
  thumbnail_url: string | null;
  files_url: string;
  proprietary: boolean;
}

export interface CadcCollection {
  collection: string;
  label: string;
  canadian: boolean;
  n_images: number;
  first_date: string | null;
  last_date: string | null;
  bands: string[];
  instruments: string[];
  images: CadcImage[];
}

export interface CadcSearch {
  ra: number;
  dec: number;
  radius_arcmin: number;
  n_images: number;
  collections: CadcCollection[];
  truncated: boolean;
  excluded_collections: string[];
  query_url: string;
  search_url: string;
  checks: Check[];
}

export interface CatalogSource {
  catalog: string;
  id: string;
  ra: number;
  dec: number;
  mag: number | null;
  mag_band: string | null;
  pm_ra_mas_yr: number | null;
  pm_dec_mas_yr: number | null;
  epoch_jyear: number;
}

export interface JobStatus<R> {
  id: string;
  kind: string;
  state: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  result: R | null;
  error: string | null;
}

export interface BandInfo {
  name: BandName;
  detector: number;
  lam_min_um: number;
  lam_max_um: number;
  resolving_power: number;
  array: string;
}

export interface DemoTarget {
  slug: string;
  label: string;
  why: string;
  suggested_band: BandName;
  target: Target;
}

export interface ReleaseInfo {
  name: string;
  label: string;
  kind: "dr" | "qr" | "other";
  number: number | null;
  deep: boolean;
}

/** SPHEREx releases discovered at IRSA (backend/app/releases.py). */
export interface Releases {
  collections: ReleaseInfo[];
  source: string;
  checked_at: string | null;
  refresh_every_hours: number;
  error: string | null;
}

export interface AppConfig {
  collections: string[];
  releases: Releases;
  bands: Record<BandName, BandInfo>;
  fov: { min: number; max: number; default: number };
  pixel_arcsec: number;
  hips: HipsLayer[];
  demo_targets: DemoTarget[];
}

export interface HipsLayer {
  id: string;
  url: string;
  label: string;
  cube: boolean;
  release_date?: string | null;
}
