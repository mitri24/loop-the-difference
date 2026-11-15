// Reference molecular bands on the quick-look spectrum (NAS-84). A dip below the fitted continuum is
// read as "consistent with" an absorption band – never as a detection of the molecule.
import type { SpectrumPoint } from './types'

export interface Band {
  id: string
  molecule: string
  // Band centre and the window read as "in the band", in µm.
  centre: number
  window: [number, number]
  // Continuum on both sides, in µm: outside the band and outside its neighbours where possible.
  left: [number, number]
  right: [number, number]
}

// Band centres: ice features measured towards background stars and protostars (Boogert, Gerakines & Whittet
// 2015, ARA&A 53, 541: H₂O 3.05, CH₃OH 3.53, CO₂ 4.27, CO 4.67 µm) and methane in T dwarf atmospheres
// (CH₄ ν₃ at 3.32 µm, e.g. Cushing et al. 2005, ApJ 623, 1115). At SPHEREx's R ≈ 35–41 between 2.4 and 4.4 µm
// a window spans about one or two resolution elements.
export const BANDS: Band[] = [
  { id: 'h2o', molecule: 'H₂O ice', centre: 3.05, window: [2.95, 3.15], left: [2.6, 2.85], right: [3.65, 3.95] },
  { id: 'ch4', molecule: 'CH₄', centre: 3.32, window: [3.25, 3.4], left: [2.6, 2.85], right: [3.65, 3.95] },
  { id: 'ch3oh', molecule: 'CH₃OH ice', centre: 3.53, window: [3.47, 3.59], left: [2.6, 2.85], right: [3.65, 3.95] },
  { id: 'co2', molecule: 'CO₂ ice', centre: 4.27, window: [4.22, 4.32], left: [4.0, 4.15], right: [4.4, 4.55] },
  { id: 'co', molecule: 'CO', centre: 4.67, window: [4.61, 4.73], left: [4.45, 4.55], right: [4.8, 4.95] },
]

export const SIGNIFICANT_SIGMA = 3
// A band where most points have flagged pixels in the aperture (saturated cores) is not read.
export const MAX_FLAGGED_SHARE = 0.5
// Continuum residuals this much larger than the errors: variability between epochs or a blend.
export const MAX_REDUCED_CHI2 = 4

export type BandStatus = 'dip' | 'none' | 'notMeasurable' | 'noContinuum' | 'saturated'

export interface BandReading {
  band: Band
  // CH₄ and CH₃OH lie in the long-wavelength wing of the broad H₂O ice band: a significant H₂O dip
  // makes theirs ambiguous.
  inWaterWing: boolean
  status: BandStatus
  // 1 − band flux / continuum, and its 1σ error; null when not measurable.
  depth: number | null
  error: number | null
  sigma: number | null
  // The continuum points scatter more than their errors allow.
  noisyContinuum: boolean
  points: number
}

const inside = (lam: number, [lo, hi]: [number, number]) => lam >= lo && lam <= hi

/**
 * Power-law continuum F = C·(λ/centre)^b. A stellar continuum is convex in F against λ (Rayleigh–Jeans
 * F ∝ λ⁻²): a straight line in F over it would read a dip that is not there. The slope b comes from a
 * weighted line in ln F against ln λ (positive fluxes only); the level C is then fitted linearly on every
 * clean point, so upward noise of a faint source does not lift it. Returns C at the centre, its variance
 * and the χ² of the clean points around the power law.
 */
export function fitContinuum(points: SpectrumPoint[], centre: number): { value: number; variance: number; chi2: number; dof: number } | null {
  const clean = points.filter((p) => p.flux_err_ujy > 0 && Number.isFinite(p.flux_ujy))
  const positive = clean.filter((p) => p.flux_ujy > 0)
  if (clean.length < 2) return null
  let slope = 0
  if (positive.length >= 2) {
    let s = 0, sx = 0, sxx = 0, sy = 0, sxy = 0
    for (const p of positive) {
      const x = Math.log(p.wavelength_um / centre)
      const y = Math.log(p.flux_ujy)
      const w = (p.flux_ujy / p.flux_err_ujy) ** 2
      s += w; sx += w * x; sxx += w * x * x; sy += w * y; sxy += w * x * y
    }
    const det = s * sxx - sx * sx
    if (det > 0) slope = (s * sxy - sx * sy) / det
  }
  const shape = (p: SpectrumPoint) => (p.wavelength_um / centre) ** slope
  const gg = clean.reduce((sum, p) => sum + shape(p) ** 2 / p.flux_err_ujy ** 2, 0)
  if (!(gg > 0)) return null
  const value = clean.reduce((sum, p) => sum + (p.flux_ujy * shape(p)) / p.flux_err_ujy ** 2, 0) / gg
  const chi2 = clean.reduce((sum, p) => sum + ((p.flux_ujy - value * shape(p)) / p.flux_err_ujy) ** 2, 0)
  return { value, variance: 1 / gg, chi2, dof: clean.length - 2 }
}

/** Depth of one band below its continuum, from unflagged points only. */
export function readBand(points: SpectrumPoint[], band: Band): BandReading {
  const inBand = points.filter((p) => inside(p.wavelength_um, band.window))
  const base = { band, inWaterWing: false, depth: null, error: null, sigma: null, noisyContinuum: false, points: inBand.length }
  if (inBand.length && inBand.filter((p) => p.flagged).length / inBand.length > MAX_FLAGGED_SHARE) return { ...base, status: 'saturated' }
  const clean = points.filter((p) => !p.flagged && p.flux_err_ujy > 0)
  const bandPoints = clean.filter((p) => inside(p.wavelength_um, band.window))
  const left = clean.filter((p) => inside(p.wavelength_um, band.left))
  const right = clean.filter((p) => inside(p.wavelength_um, band.right))
  const sides = [...left, ...right]
  if (!bandPoints.length || !left.length || !right.length) return { ...base, status: 'notMeasurable' }
  // Empty sky: most continuum points at or below zero. A power law through the positive noise is no continuum.
  if (sides.filter((p) => p.flux_ujy > 0).length * 2 <= sides.length) return { ...base, status: 'noContinuum' }
  const continuum = fitContinuum(sides, band.centre)
  if (!continuum) return { ...base, status: 'notMeasurable' }
  // No flux above the sky around the band: a depth would be noise over noise.
  if (!(continuum.value > 0) || continuum.value < 3 * Math.sqrt(continuum.variance)) return { ...base, status: 'noContinuum' }
  const weights = bandPoints.map((p) => 1 / p.flux_err_ujy ** 2)
  const total = weights.reduce((s, w) => s + w, 0)
  const flux = bandPoints.reduce((s, p, i) => s + weights[i] * p.flux_ujy, 0) / total
  const fluxVariance = 1 / total
  const depth = 1 - flux / continuum.value
  const error = Math.sqrt(fluxVariance / continuum.value ** 2 + (flux ** 2 * continuum.variance) / continuum.value ** 4)
  const sigma = error > 0 ? depth / error : null
  const noisyContinuum = continuum.dof > 0 && continuum.chi2 / continuum.dof > MAX_REDUCED_CHI2
  const status: BandStatus = sigma !== null && depth > 0 && sigma >= SIGNIFICANT_SIGMA ? 'dip' : 'none'
  return { ...base, status, depth, error, sigma, noisyContinuum, points: bandPoints.length }
}

const IN_WATER_WING = new Set(['ch4', 'ch3oh'])

export function readBands(points: SpectrumPoint[]): BandReading[] {
  const readings = BANDS.map((band) => readBand(points, band))
  const water = readings.find((r) => r.band.id === 'h2o')?.status === 'dip'
  return readings.map((r) => (water && IN_WATER_WING.has(r.band.id) && r.status === 'dip' ? { ...r, inWaterWing: true } : r))
}

const pct = (value: number) => (Number.isFinite(value) ? `${(100 * value).toFixed(Math.abs(value) < 0.01 ? 1 : 0)} %` : '–')

/** One honest sentence per band. */
export function bandText(reading: BandReading): string {
  const { band, status, depth, error, sigma } = reading
  const name = `${band.molecule} ${band.centre.toFixed(2)} µm`
  if (status === 'saturated') return `${name}: saturated – flagged pixels in most points, depth unusable`
  if (status === 'notMeasurable') return `${name}: not measurable here (no clean points in the band or on both sides)`
  if (status === 'noContinuum') return `${name}: no significant flux around the band – nothing to read a dip against`
  const measured = `${pct(depth!)} ± ${pct(error!)}${sigma !== null ? ` (${sigma.toFixed(1)}σ)` : ''}`
  if (status !== 'dip') return `${name}: no significant dip (${measured})`
  const wing = reading.inWaterWing ? ' (inside the wing of the H₂O band: it may be the same dip)' : ''
  return `${name}: dip ${measured} – consistent with ${band.molecule} absorption${wing}, needs verification`
}
