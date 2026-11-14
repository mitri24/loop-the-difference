import type { ProperMotion } from './types'

const MJD_J2000 = 51544.5
const DAYS_PER_YEAR = 365.25
const rad = (deg: number) => (deg * Math.PI) / 180

// Where a Gaia star stands at a frame's date, as a fraction of the frame from its top left corner.
// Same linear propagation as match_gaia_csv in backend/app/catalogs.py.
// The frames share one grid: centred on (ra0, dec0), size_deg wide, north up, east left (TAN).
export function markerPosition(
  star: ProperMotion,
  mjd: number,
  ra0: number,
  dec0: number,
  sizeDeg: number,
): { x: number; y: number } | null {
  const years = 2000 + (mjd - MJD_J2000) / DAYS_PER_YEAR - star.ref_epoch
  const dec = rad(star.dec + (star.pmdec_mas_yr * years) / 3.6e6)
  const dRa = rad((star.pmra_mas_yr * years) / 3.6e6 / Math.cos(rad(star.dec)) + star.ra - ra0)
  const d0 = rad(dec0)
  const cosC = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dRa)
  if (cosC <= 0) return null
  const xi = (Math.cos(dec) * Math.sin(dRa)) / cosC
  const eta = (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dRa)) / cosC
  const x = 0.5 - xi / rad(sizeDeg)
  const y = 0.5 - eta / rad(sizeDeg)
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
