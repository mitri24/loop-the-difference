import { describe, expect, it } from 'vitest'
import { dateToMjd, dssUrl, plateHeader, predictedOnPlate } from './historicalPlate'
import type { ProperMotion } from './types'

// Same Gaia DR3 values as motion.test.ts (backend/tests/fixtures/gaia_barnard.csv).
const BARNARD: ProperMotion = {
  source_id: '4472832130942575872',
  ra: 269.44850252543836,
  dec: 4.739420051112412,
  ref_epoch: 2016.0,
  pmra_mas_yr: -801.5509783684709,
  pmdec_mas_yr: 10362.394206546573,
  parallax_mas: 546.975939730948,
}

const card = (text: string) => text.padEnd(80, ' ')
const header = (...cards: string[]) => new TextEncoder().encode([...cards, 'END'].map(card).join('').padEnd(2880, ' '))

describe('historical plate', () => {
  it('asks STScI for a POSS-I red FITS cutout of the field', () => {
    expect(dssUrl(269.452083, 4.693364)).toBe(
      'https://archive.stsci.edu/cgi-bin/dss_search?v=poss1_red&r=269.452083&d=4.693364&e=J2000&h=20&w=20&f=fits&c=none&fov=NONE&v3=',
    )
  })

  it('reads survey, plate id and the date part of a malformed DATE-OBS', () => {
    const bytes = header(
      'SIMPLE  =                    T /FITS: Compliance',
      "SURVEY  = 'POSSI-E '           /GSSS: Sky Survey",
      "PLATEID = '099V    '           /GSSS: Plate ID",
      "DATE-OBS= '1950-07-09T06:75:00' /Observation: Date/Time",
    )
    expect(plateHeader(bytes)).toEqual({ survey: 'POSSI-E', plateId: '099V', date: '1950-07-09' })
  })

  it('stops at END and needs a date', () => {
    expect(plateHeader(header("SURVEY  = 'POSSI-E '"))).toBeNull()
    const afterEnd = new TextEncoder().encode(['END', "DATE-OBS= '1950-07-09'"].map(card).join(''))
    expect(plateHeader(afterEnd)).toBeNull()
  })

  it('predicts Barnard’s Star on the 1950 plate within 1″ of its catalogued 1950 position', () => {
    expect(dateToMjd('1950-07-09')).toBe(33471)
    const at = predictedOnPlate(BARNARD, '1950-07-09')
    const offArcsec = Math.hypot((at.ra - 269.46313) * Math.cos((4.55 * Math.PI) / 180), at.dec - 4.55093) * 3600
    expect(offArcsec).toBeLessThan(1)
  })
})
