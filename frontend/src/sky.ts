// Sky-view rules that need no DOM: the surveys we show, the SPHEREx cube slice per detector
// and the outline of the frame on the sky.
import type { SkyCoords } from 'aladin-lite'

export interface Survey {
  id: string
  name: string
  url: string
}

// Mirrors that answer with CORS headers; SPHEREx first.
export const SURVEYS: Survey[] = [
  {
    id: 'spherex-dr1',
    name: 'SPHEREx DR1 all-sky (NASA/IPAC)',
    url: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
  },
  { id: 'allwise', name: 'AllWISE colour (ESA mirror)', url: 'https://skies.esac.esa.int/AllWISEColor' },
  { id: '2mass', name: '2MASS colour (ESA mirror)', url: 'https://skies.esac.esa.int/2MASSColor' },
  { id: 'dss2', name: 'DSS2 colour (ESA mirror)', url: 'https://skies.esac.esa.int/DSSColor' },
]
export const SPHEREX = SURVEYS[0]
export const ALLWISE = SURVEYS[1]

// The SPHEREx all-sky HiPS is a cube of 102 frames, frame = 17 · (band − 1) + (channel − 1).
// One frame per detector: its middle channel, wavelength from the cube's crval3 table (IRSA).
const CUBE_FRAME_BY_DETECTOR: Record<number, { slice: number; um: number }> = {
  1: { slice: 8, um: 0.91 },
  2: { slice: 25, um: 1.35 },
  3: { slice: 42, um: 2.0 },
  4: { slice: 59, um: 3.03 },
  5: { slice: 76, um: 4.11 },
  6: { slice: 93, um: 4.7 },
}

export function sliceForDetector(detector: number): number {
  return CUBE_FRAME_BY_DETECTOR[detector].slice
}

export function spherexLabel(detector: number): string {
  return `SPHEREx DR1, D${detector} (~${CUBE_FRAME_BY_DETECTOR[detector].um.toFixed(1)} µm)`
}

const DEG = Math.PI / 180

// Corners of the frame: a square of sizeDeg on the tangent plane at (ra, dec), north up – the
// TAN projection the backend cutout grid uses. Null when the square contains a celestial pole;
// a circle marks the frame then, because the outline is no polygon in RA/Dec any more.
export function footprintCorners(ra: number, dec: number, sizeDeg: number): SkyCoords[] | null {
  const half = sizeDeg / 2
  if (Math.abs(dec) + half * Math.SQRT2 >= 90) return null
  const offsets: Array<[number, number]> = [
    [-half, half],
    [half, half],
    [half, -half],
    [-half, -half],
  ]
  return offsets.map(([x, y]) => tangentToSky(ra, dec, x, y))
}

function tangentToSky(ra0: number, dec0: number, xDeg: number, yDeg: number): SkyCoords {
  const x = xDeg * DEG
  const y = yDeg * DEG
  const sinDec = Math.sin(dec0 * DEG)
  const cosDec = Math.cos(dec0 * DEG)
  const dec = Math.asin((sinDec + y * cosDec) / Math.sqrt(1 + x * x + y * y)) / DEG
  const ra = ra0 + Math.atan2(x, cosDec - y * sinDec) / DEG
  return [((ra % 360) + 360) % 360, dec]
}
