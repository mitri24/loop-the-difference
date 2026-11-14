import { propagateGaia } from './catalogLayers'
import type { ProperMotion } from './types'

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
  const now = propagateGaia(
    { ra: star.ra, dec: star.dec, pmRa: star.pmra_mas_yr, pmDec: star.pmdec_mas_yr },
    mjd,
    star.ref_epoch,
  )
  return skyToFrame(now.ra, now.dec, ra0, dec0, sizeDeg)
}

// A sky position as a fraction of the frame grid from its top left corner; null outside it.
export function skyToFrame(
  ra: number,
  decDeg: number,
  ra0: number,
  dec0: number,
  sizeDeg: number,
): { x: number; y: number } | null {
  const dec = rad(decDeg)
  const dRa = rad(ra - ra0)
  const d0 = rad(dec0)
  const cosC = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dRa)
  if (cosC <= 0) return null
  const xi = (Math.cos(dec) * Math.sin(dRa)) / cosC
  const eta = (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dRa)) / cosC
  const x = 0.5 - xi / rad(sizeDeg)
  const y = 0.5 - eta / rad(sizeDeg)
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
