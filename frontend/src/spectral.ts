// The comparison parameters the UI shares with the backend (backend/app/frames.py) and the analysis service:
// comparabilityParameters.test.ts fails when they drift.
// Resolving power λ/Δλ per detector (IRSA SPHEREx data products).
export const R_BY_DETECTOR: Record<number, number> = { 1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128 }
// Two wavelengths match within this share of one resolution element (|Δλ|/λ̄ ≤ fraction / R); up to a whole element
// they are close (a warning in the checks), beyond it a different wavelength (a blocker).
export const WAVELENGTH_MATCH_FRACTION = 0.5

export function sameWavelength(a: number | null, b: number | null, detector: number): boolean {
  const r = R_BY_DETECTOR[detector]
  if (a == null || b == null || !r) return false
  return Math.abs(a - b) / ((a + b) / 2) <= WAVELENGTH_MATCH_FRACTION / r
}
