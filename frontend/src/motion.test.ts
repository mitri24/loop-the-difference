import { describe, expect, it } from 'vitest'
import { frameToSky, markerPosition, skyToFrame } from './motion'
import type { ProperMotion } from './types'

// Gaia DR3 4472832130942575872 (Barnard's Star), from backend/tests/fixtures/gaia_barnard.csv
const BARNARD: ProperMotion = {
  source_id: '4472832130942575872',
  ra: 269.44850252543836,
  dec: 4.739420051112412,
  ref_epoch: 2016.0,
  pmra_mas_yr: -801.5509783684709,
  pmdec_mas_yr: 10362.394206546573,
  parallax_mas: 546.975939730948,
}
const J2000 = { ra: 269.452083, dec: 4.693364 }
const MJD_2016 = 57388.5
const MJD_2025_5 = 60858.375 // ≈ 2025.5

describe('proper-motion marker', () => {
  it('sits at the frame centre at J2000, the epoch of the resolved coordinates', () => {
    const at = markerPosition(BARNARD, 51544.5, J2000.ra, J2000.dec, 0.2)!
    expect(at.x).toBeCloseTo(0.5, 2)
    expect(at.y).toBeCloseTo(0.5, 2)
  })

  it('moves Barnard’s Star north (up) by about 4.5′ by 2025', () => {
    const at = markerPosition(BARNARD, MJD_2025_5, J2000.ra, J2000.dec, 0.2)!
    const northArcmin = (0.5 - at.y) * 0.2 * 60
    expect(northArcmin).toBeGreaterThan(4.3)
    expect(northArcmin).toBeLessThan(4.6)
    expect(at.x).toBeGreaterThan(0.5) // pmra < 0: west, which is right with east left
  })

  it('returns the Gaia position at the Gaia epoch, and null outside the frame', () => {
    const at = markerPosition(BARNARD, MJD_2016, BARNARD.ra, BARNARD.dec, 0.2)!
    expect(at.x).toBeCloseTo(0.5, 6)
    expect(at.y).toBeCloseTo(0.5, 6)
    expect(markerPosition(BARNARD, MJD_2025_5, J2000.ra, J2000.dec, 0.05)).toBeNull()
  })
})

describe('frameToSky', () => {
  it('inverts skyToFrame, also at the pole and across RA 0', () => {
    for (const [ra0, dec0] of [[38.02, 89.27], [0.01, -10], [210, 45]]) {
      for (const [x, y] of [[0.5, 0.5], [0.1, 0.9], [0.83, 0.27]]) {
        const sky = frameToSky(x, y, ra0, dec0, 0.2)
        const back = skyToFrame(sky.ra, sky.dec, ra0, dec0, 0.2)
        expect(back!.x).toBeCloseTo(x, 9)
        expect(back!.y).toBeCloseTo(y, 9)
      }
    }
  })

  it('puts the centre on the field centre and east to the left', () => {
    const centre = frameToSky(0.5, 0.5, 120, 30, 0.2)
    expect(centre.ra).toBeCloseTo(120, 9)
    expect(centre.dec).toBeCloseTo(30, 9)
    expect(frameToSky(0.2, 0.5, 120, 30, 0.2).ra).toBeGreaterThan(120)
  })
})
