// Field catalogues for the sky view. Mirrors, CORS and epochs: see NAS-22 "Service status and CORS".
const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/votable'
const MJD_UNIX_EPOCH = 40587
const MJD_J2000 = 51544.5
const GAIA_EPOCH_YR = 2016.0

// Space must become %20: URLSearchParams would write "+", which the services read literally.
const cone = (ra: number, dec: number) => encodeURIComponent(`${ra} ${dec}`)

export const gaiaUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=I/355/gaiadr3&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=500&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag`

export const wiseUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=II/328/allwise&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=500&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag`

export const simbadUrl = (ra: number, dec: number, rDeg: number) =>
  `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${cone(ra, dec)}&Radius=${rDeg * 60}&Radius.unit=arcmin&output.format=votable`

// Asteroids move: the epoch is the shown frame's time, passed as Julian Date.
export const skybotUrl = (ra: number, dec: number, rDeg: number, mjd: number) =>
  `https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep=${mjd + 2400000.5}&-ra=${ra}&-dec=${dec}&-rd=${rDeg}&-mime=votable&-output=object&-from=LoopTheDifference`

/** Query radius in degrees: a bit wider than the view, never smaller than the frames, at most 1°. */
export const catalogRadius = (fovDeg: number, sizeDeg: number) =>
  Math.min(1, Math.max(0.75 * fovDeg, sizeDeg))

/** Calendar date (UTC, YYYY-MM-DD) of a frame, for the SkyBoT legend. */
export const isoDate = (mjd: number) =>
  new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000).toISOString().slice(0, 10)

export interface GaiaRow {
  ra: number
  dec: number
  pmRa: number
  pmDec: number
}

/** Moves a Gaia DR3 position (J2016.0, proper motion in mas/yr, pmRA = μα*) to the frame's epoch. */
export function propagateGaia(row: GaiaRow, mjd: number) {
  const dt = 2000 + (mjd - MJD_J2000) / 365.25 - GAIA_EPOCH_YR
  const dec = row.dec + (row.pmDec / 3.6e6) * dt
  const ra = row.ra + ((row.pmRa / 3.6e6) * dt) / Math.cos((row.dec * Math.PI) / 180)
  return { ra, dec }
}
