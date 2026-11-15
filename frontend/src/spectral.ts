// Spectral resolving power per detector, as R_BY_DETECTOR in backend/app/frames.py: two wavelengths compare
// directly when |Δλ| / λ ≤ 1 / R (one resolution element).
export const R_BY_DETECTOR: Record<number, number> = { 1: 41, 2: 41, 3: 41, 4: 35, 5: 110, 6: 130 }

export function sameWavelength(a: number | null, b: number | null, detector: number): boolean {
  const r = R_BY_DETECTOR[detector]
  if (a == null || b == null || !r) return false
  return Math.abs(a - b) / ((a + b) / 2) <= 1 / r
}
