// The comparison parameters the UI shares with the backend (backend/app/frames.py) and the analysis service:
// comparabilityParameters.test.ts fails when they drift.
// Resolving power λ/Δλ per detector (IRSA SPHEREx data products).
export const R_BY_DETECTOR: Record<number, number> = { 1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128 }
// Two wavelengths match within this share of one resolution element (|Δλ|/λ̄ ≤ fraction / R); up to a whole element
// (the limit) they are close (a warning in the checks), beyond it a different wavelength (a blocker).
export const WAVELENGTH_MATCH_FRACTION = 0.5
export const WAVELENGTH_LIMIT_FRACTION = 1

export type WavelengthVerdict = 'same' | 'close' | 'different' | 'unknown'

// How far apart two wavelengths are, in % of their mean and as the checks judge it.
export function compareWavelengths(a: number | null, b: number | null, detector: number): { pct: number | null; verdict: WavelengthVerdict } {
  const r = R_BY_DETECTOR[detector]
  if (a == null || b == null || !r) return { pct: null, verdict: 'unknown' }
  const share = Math.abs(a - b) / ((a + b) / 2)
  const verdict = share <= WAVELENGTH_MATCH_FRACTION / r ? 'same' : share <= WAVELENGTH_LIMIT_FRACTION / r ? 'close' : 'different'
  return { pct: share * 100, verdict }
}

export function sameWavelength(a: number | null, b: number | null, detector: number): boolean {
  const r = R_BY_DETECTOR[detector]
  if (a == null || b == null || !r) return false
  return Math.abs(a - b) / ((a + b) / 2) <= WAVELENGTH_MATCH_FRACTION / r
}
