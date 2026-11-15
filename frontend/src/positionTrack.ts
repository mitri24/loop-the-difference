// Position over time (NAS-79): where one object stands in every frame of the comparison, read from the detections
// the worker found in that frame (backend/app/sources.py), as east and north offsets from its first detection.
// Besides the blink and the brightness over time, this is the third view a mentor asked for: a moving star draws a
// straight trend, a fixed one a flat line.
import { propagateGaia } from './catalogLayers'
import { nearestSource, sigmaFor } from './candidate'
import type { DetectedSource, Frame, ProperMotion } from './types'

// The same reach as a mark (candidate.ts): the nearest detection within two pixels of where the object is expected.
export const FOLLOW_PIXELS = 2
// Frames less than a month apart come from one visit: too short a time span for a yearly motion.
export const MIN_BASELINE_DAYS = 30
// A motion counts as measured from 3σ on, the rule of the candidate check and the ticket.
export const SIGNIFICANT_SIGMA = 3
const DAYS_PER_YEAR = 365.25

export interface Offset {
  east: number // arcsec on the sky, ΔRA·cos δ
  north: number // arcsec, ΔDec
}

export interface PositionPoint extends Offset {
  frame: Frame
  source: DetectedSource
  sigma: number // 1σ per axis in arcsec (sigmaFor: rms offset to Gaia DR3 in real SPHEREx frames)
  predicted: Offset | null // the Gaia DR3 prediction, from its own position at the first detection's date
}

export interface PositionGap {
  frame: Frame
  reason: string
}

// Yearly motion from a weighted straight-line fit per axis, in arcsec per year.
export interface MotionFit extends Offset {
  sigmaEast: number
  sigmaNorth: number
  total: number
  sigmaTotal: number
}

export interface PositionTrack {
  points: PositionPoint[]
  gaps: PositionGap[]
  baselineDays: number
  fit: MotionFit | null
  predictedTotal: number | null // Gaia DR3's total proper motion in arcsec per year, when it predicts the positions
}

/** East and north offset in arcsec of (ra, dec) from (ra0, dec0); RA wrapped at 0/360, scaled by cos δ0. */
export function offsetArcsec(ra0: number, dec0: number, ra: number, dec: number): Offset {
  const dRa = ((ra - ra0 + 540) % 360) - 180
  return { east: dRa * Math.cos((dec0 * Math.PI) / 180) * 3600, north: (dec - dec0) * 3600 }
}

const gaiaAt = (motion: ProperMotion, mjd: number) =>
  propagateGaia({ ra: motion.ra, dec: motion.dec, pmRa: motion.pmra_mas_yr, pmDec: motion.pmdec_mas_yr }, mjd, motion.ref_epoch)

/**
 * Follows one object through the frames, oldest first. With a Gaia DR3 proper motion the object is expected where
 * Gaia predicts it at each frame's date; without one, where it was last detected (first: at `start`). The nearest
 * detection within FOLLOW_PIXELS of that place counts; a frame without one is a gap with its reason, never filled in.
 */
export function followPosition(
  frames: Frame[],
  start: { ra: number; dec: number },
  pixelScaleArcsec: number,
  motion?: ProperMotion | null,
): PositionTrack {
  const reach = FOLLOW_PIXELS * pixelScaleArcsec
  const found: { frame: Frame; source: DetectedSource; gaia: { ra: number; dec: number } | null }[] = []
  const gaps: PositionGap[] = []
  let expected = start
  for (const frame of [...frames].sort((a, b) => a.mjd - b.mjd)) {
    const gaia = motion ? gaiaAt(motion, frame.mjd) : null
    if (!frame.sources) {
      gaps.push({ frame, reason: 'prepared before source detection existed' })
      continue
    }
    const best = nearestSource(frame.sources, (gaia ?? expected).ra, (gaia ?? expected).dec, reach)
    if (!best) {
      gaps.push({ frame, reason: `no detection within ${FOLLOW_PIXELS} px (${Math.round(reach)}″) of the expected position` })
      continue
    }
    found.push({ frame, source: best.source, gaia })
    if (!gaia) expected = { ra: best.source.ra, dec: best.source.dec }
  }
  const first = found[0]
  const points: PositionPoint[] = found.map(({ frame, source, gaia }) => ({
    frame,
    source,
    ...offsetArcsec(first.source.ra, first.source.dec, source.ra, source.dec),
    sigma: sigmaFor(source.snr, source.saturated),
    predicted: gaia && first.gaia ? offsetArcsec(first.gaia.ra, first.gaia.dec, gaia.ra, gaia.dec) : null,
  }))
  const baselineDays = points.length ? points.at(-1)!.frame.mjd - points[0].frame.mjd : 0
  const predictedTotal = motion ? Math.hypot(motion.pmra_mas_yr, motion.pmdec_mas_yr) / 1000 : null
  return { points, gaps, baselineDays, fit: fitMotion(points), predictedTotal }
}

// Weighted least squares y = a + b·t with weights 1/σ²; from three points on the error grows with the scatter
// (√χ²ᵣ when that exceeds 1), so frames that disagree more than their bars say do not claim a tight motion.
function slope(t: number[], y: number[], sigma: number[]) {
  const w = sigma.map((s) => 1 / (s * s))
  const sw = w.reduce((a, b) => a + b, 0)
  const tm = w.reduce((a, wi, i) => a + wi * t[i], 0) / sw
  const ym = w.reduce((a, wi, i) => a + wi * y[i], 0) / sw
  const stt = w.reduce((a, wi, i) => a + wi * (t[i] - tm) ** 2, 0)
  const b = w.reduce((a, wi, i) => a + wi * (t[i] - tm) * (y[i] - ym), 0) / stt
  let error = 1 / Math.sqrt(stt)
  if (t.length >= 3) {
    const chi2 = w.reduce((a, wi, i) => a + wi * (y[i] - ym - b * (t[i] - tm)) ** 2, 0) / (t.length - 2)
    if (chi2 > 1) error *= Math.sqrt(chi2)
  }
  return { rate: b, error }
}

/** The yearly motion through the points, or null below two points or a month of time span. */
export function fitMotion(points: PositionPoint[]): MotionFit | null {
  if (points.length < 2) return null
  const years = points.map((p) => (p.frame.mjd - points[0].frame.mjd) / DAYS_PER_YEAR)
  if ((years.at(-1)! - years[0]) * DAYS_PER_YEAR < MIN_BASELINE_DAYS) return null
  const sigma = points.map((p) => p.sigma)
  const east = slope(years, points.map((p) => p.east), sigma)
  const north = slope(years, points.map((p) => p.north), sigma)
  const total = Math.hypot(east.rate, north.rate)
  const sigmaTotal = total > 0
    ? Math.hypot(east.rate * east.error, north.rate * north.error) / total
    : Math.max(east.error, north.error)
  return { east: east.rate, north: north.rate, sigmaEast: east.error, sigmaNorth: north.error, total, sigmaTotal }
}

// Two decimals below 10″ per year, one from there on (9.999 reads 10.0, not 10.00).
const fmt = (value: number) => value.toFixed(Number(value.toFixed(2)) >= 10 ? 1 : 2)

/** The result in one line: the measured yearly motion and, beside it, what Gaia DR3 predicts. */
export function resultLine(track: PositionTrack): string {
  const { fit, points, baselineDays, predictedTotal } = track
  if (points.length < 2) return 'Fewer than two frames have a detection here: no position over time.'
  if (!fit) return `The frames span ${Math.max(1, Math.round(baselineDays))} days: too short to measure a yearly motion.`
  const gaia = predictedTotal == null ? '' : ` · Gaia DR3 predicts ${fmt(predictedTotal)}″ per year`
  if (fit.total < SIGNIFICANT_SIGMA * fit.sigmaTotal) {
    return `No significant shift: ${fmt(fit.total)} ± ${fmt(fit.sigmaTotal)}″ per year${gaia}`
  }
  return `Shifts ${fmt(fit.total)} ± ${fmt(fit.sigmaTotal)}″ per year in these frames${gaia}`
}
