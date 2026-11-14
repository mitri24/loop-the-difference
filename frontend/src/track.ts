// Possible track from the user's marks: a straight line in the tangent plane at the field centre,
// used only where a straight line is physically valid. Never an orbit, never a verdict.
import { insideFrame, nearestSource, type Evidence, type Mark } from './candidate'
import { skyToTangent } from './motion'
import { tangentToSky } from './sky'
import { EPOCH_GAP_DAYS } from './timeAxis'
import type { DetectedSource, Frame, FrameManifest } from './types'

const ARCSEC_PER_RAD = (180 / Math.PI) * 3600
export const DAYS_PER_YEAR = 365.25
// Barnard's Star, the fastest star on the sky.
export const FASTEST_STAR_ARCSEC_YR = 10.4
// Validity window of a straight line for a possible Solar System body (ticket choice: ±1 d).
export const FAST_WINDOW_DAYS = 1
export const SEARCH_AREA_LABEL = '2σ, from mark precision only'

export interface TrackFit {
  centre: { ra: number; dec: number }
  n: number
  tMean: number
  // Position at tMean and rate per axis in the tangent plane, arcsec and arcsec/day (ξ east, η north).
  xi: number
  eta: number
  vXi: number
  vEta: number
  sigma: number
  sumTT: number
  rate: number
  sigmaRate: number
  // Position angle of the motion, degrees east of north.
  pa: number
  // RMS of the residual separations; only meaningful with three or more marks.
  rmsArcsec: number | null
}

/** Least squares per axis, t in days; σ per axis = rms of the marks' σ. Null below two dates. */
export function fitTrack(marks: Mark[], centre: { ra: number; dec: number }): TrackFit | null {
  const points = marks.flatMap((m) => {
    const t = skyToTangent(m.ra, m.dec, centre.ra, centre.dec)
    return t ? [{ t: m.mjd, x: t.xi * ARCSEC_PER_RAD, y: t.eta * ARCSEC_PER_RAD, s: m.sigma_arcsec }] : []
  })
  const n = points.length
  if (n < 2) return null
  const mean = (f: (p: (typeof points)[number]) => number) => points.reduce((sum, p) => sum + f(p), 0) / n
  const tMean = mean((p) => p.t)
  const xi = mean((p) => p.x)
  const eta = mean((p) => p.y)
  const sumTT = points.reduce((sum, p) => sum + (p.t - tMean) ** 2, 0)
  if (sumTT === 0) return null
  const vXi = points.reduce((sum, p) => sum + (p.t - tMean) * (p.x - xi), 0) / sumTT
  const vEta = points.reduce((sum, p) => sum + (p.t - tMean) * (p.y - eta), 0) / sumTT
  const sigma = Math.sqrt(mean((p) => p.s ** 2))
  const residual2 = mean((p) => (p.x - xi - vXi * (p.t - tMean)) ** 2 + (p.y - eta - vEta * (p.t - tMean)) ** 2)
  return {
    centre, n, tMean, xi, eta, vXi, vEta, sigma, sumTT,
    rate: Math.hypot(vXi, vEta),
    sigmaRate: sigma / Math.sqrt(sumTT),
    pa: ((Math.atan2(vXi, vEta) * 180) / Math.PI + 360) % 360,
    rmsArcsec: n >= 3 ? Math.sqrt(residual2) : null,
  }
}

export interface Prediction {
  mjd: number
  ra: number
  dec: number
  // Drawn search radius: 2σ of the prediction.
  radius_arcsec: number
}

export function predict(fit: TrackFit, mjd: number): Prediction {
  const dt = mjd - fit.tMean
  const [ra, dec] = tangentToSky(
    fit.centre.ra, fit.centre.dec, (fit.xi + fit.vXi * dt) / 3600, (fit.eta + fit.vEta * dt) / 3600,
  )
  const sigmaPred = fit.sigma * Math.sqrt(1 / fit.n + dt ** 2 / fit.sumTT)
  return { mjd, ra, dec, radius_arcsec: 2 * sigmaPred }
}

export const REGIMES = {
  none: { icon: '·', word: 'No significant motion', note: 'The marks agree within 3σ of their precision. No track is drawn.' },
  fast: {
    icon: '↗', word: 'Faster than any star (Barnard’s Star 10.4″/yr) – a Solar System body is possible',
    note: 'Straight-line prediction only within 1 day of the marks.',
  },
  stellar: { icon: '★', word: 'Consistent with stellar proper motion', note: 'Straight-line prediction at every frame date.' },
  solarSystem: {
    icon: '⤳', word: 'Not a straight line across half a year – if one object, it is in the Solar System',
    note: 'No straight-line prediction across epochs; it needs an assumed distance.',
  },
} as const
export type Regime = keyof typeof REGIMES

export function regime(fit: TrackFit, marks: Pick<Mark, 'mjd'>[]): Regime {
  if (fit.rate < 3 * fit.sigmaRate) return 'none'
  const mjds = marks.map((m) => m.mjd)
  if (Math.max(...mjds) - Math.min(...mjds) <= EPOCH_GAP_DAYS) return 'fast'
  return (fit.rate - 3 * fit.sigmaRate) * DAYS_PER_YEAR <= FASTEST_STAR_ARCSEC_YR ? 'stellar' : 'solarSystem'
}

export interface PossibleTrack {
  fit: TrackFit
  regime: Regime
  predictions: Prediction[]
}

/** Fit, regime and the predictions at those frame dates where a straight line is valid. */
export function possibleTrack(marks: Mark[], centre: { ra: number; dec: number }, mjds: number[]): PossibleTrack | null {
  const fit = fitTrack(marks, centre)
  if (!fit) return null
  const kind = regime(fit, marks)
  const first = Math.min(...marks.map((m) => m.mjd)) - FAST_WINDOW_DAYS
  const last = Math.max(...marks.map((m) => m.mjd)) + FAST_WINDOW_DAYS
  const valid = (mjd: number) => kind === 'stellar' || (kind === 'fast' && mjd >= first && mjd <= last)
  const dates = [...new Set(mjds)].filter(valid).sort((a, b) => a - b)
  return { fit, regime: kind, predictions: dates.map((mjd) => predict(fit, mjd)) }
}

export function trackEvidence(track: PossibleTrack | null): Evidence {
  return { motion: track?.regime === 'stellar', fastMotion: track?.regime === 'fast' || track?.regime === 'solarSystem' }
}

// A detection counts as at the prediction within 2σ of the prediction, but never closer than
// 1.5 SPHEREx pixels: centroids of the same blob scatter by about a pixel.
export const SEARCH_PIXELS = 1.5
// Mirrors MAX_SOURCES in backend/app/sources.py: a full list holds only the brightest detections.
export const SPHEREX_SOURCE_CAP = 300

export type LookBack =
  | { kind: 'detection'; source: DetectedSource; sep_arcsec: number }
  | { kind: 'nothing' | 'outside' | 'window' | 'noSources' }

export interface FrameCheck {
  index: number
  frame: Frame
  // Null outside the straight-line window.
  prediction: Prediction | null
  radius_arcsec: number
  result: LookBack
}

/** Every frame without a mark, in time order: the nearest ≥5σ detection in the search area at the prediction. */
export function checkFrames(
  track: PossibleTrack, frames: Frame[], marks: Pick<Mark, 'obs_id'>[],
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'pixel_scale_arcsec'>,
): FrameCheck[] {
  const marked = new Set(marks.map((m) => m.obs_id))
  return frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => !marked.has(frame.obs_id))
    .sort((a, b) => a.frame.mjd - b.frame.mjd)
    .map(({ frame, index }) => {
      const prediction = track.predictions.find((p) => p.mjd === frame.mjd) ?? null
      const radius_arcsec = Math.max(prediction?.radius_arcsec ?? 0, SEARCH_PIXELS * grid.pixel_scale_arcsec)
      const row = { index, frame, prediction, radius_arcsec }
      if (!prediction) return { ...row, result: { kind: 'window' as const } }
      if (!insideFrame(prediction.ra, prediction.dec, grid)) return { ...row, result: { kind: 'outside' as const } }
      if (!frame.sources) return { ...row, result: { kind: 'noSources' as const } }
      const nearest = nearestSource(frame.sources, prediction.ra, prediction.dec, radius_arcsec)
      return nearest
        ? { ...row, result: { kind: 'detection' as const, ...nearest } }
        : { ...row, result: { kind: 'nothing' as const } }
    })
}
