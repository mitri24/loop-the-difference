import { describe, expect, it } from 'vitest'
import { trackPoints } from './motionTrack'
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
const MJD_2016 = 57388.5

describe('predicted motion track', () => {
  it('starts at the Gaia position at the Gaia epoch', () => {
    const [p] = trackPoints(BARNARD, [MJD_2016])
    expect(p.ra).toBeCloseTo(BARNARD.ra, 9)
    expect(p.dec).toBeCloseTo(BARNARD.dec, 9)
  })

  it('moves Barnard’s Star about 10.4″ north in one year', () => {
    const [a, b] = trackPoints(BARNARD, [MJD_2016, MJD_2016 + 365.25])
    expect((b.dec - a.dec) * 3600).toBeCloseTo(10.362, 2)
    expect(b.ra).toBeLessThan(a.ra)
  })

  it('sorts and de-duplicates the dates and labels the first date of each epoch', () => {
    const points = trackPoints(BARNARD, [60990, 60796, 60800, 60796])
    expect(points.map((p) => p.mjd)).toEqual([60796, 60800, 60990])
    expect(points.map((p) => p.label)).toEqual(['2025-05-01', '', '2025-11-11'])
  })

  it('keeps right ascension within 0–360°', () => {
    const star = { ...BARNARD, ra: 0.000001, pmra_mas_yr: -1000 }
    const [p] = trackPoints(star, [MJD_2016 + 3652.5])
    expect(p.ra).toBeGreaterThan(359)
    expect(p.ra).toBeLessThan(360)
  })
})
