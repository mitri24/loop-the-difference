import { describe, expect, it } from 'vitest'
import {
  catalogRadius,
  gaiaUrl,
  isoDate,
  propagateGaia,
  simbadUrl,
  skybotUrl,
  wiseUrl,
} from './catalogLayers'

describe('catalogue URLs', () => {
  it('encodes the cone centre with %20, never +', () => {
    for (const url of [gaiaUrl(269.45, 4.69, 0.2), wiseUrl(269.45, 4.69, 0.2), simbadUrl(269.45, 4.69, 0.2)]) {
      expect(url).toContain('269.45%204.69')
      expect(url).not.toContain('+')
    }
  })

  it('asks Gaia DR3 for the columns the propagation needs', () => {
    expect(gaiaUrl(1, -2, 0.5)).toBe(
      'https://vizier.cfa.harvard.edu/viz-bin/votable?-source=I/355/gaiadr3&-c=1%20-2&-c.rd=0.5&-out.max=500&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag',
    )
  })

  it('asks AllWISE for id, position and W1/W2', () => {
    expect(wiseUrl(1, -2, 0.5)).toBe(
      'https://vizier.cfa.harvard.edu/viz-bin/votable?-source=II/328/allwise&-c=1%20-2&-c.rd=0.5&-out.max=500&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag',
    )
  })

  it('gives SIMBAD the radius in arcminutes', () => {
    expect(simbadUrl(1, -2, 0.5)).toBe(
      'https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=1%20-2&Radius=30&Radius.unit=arcmin&output.format=votable',
    )
  })

  it('asks SkyBoT at the frame epoch as Julian Date', () => {
    expect(skybotUrl(1, -2, 0.5, 60858.5)).toBe(
      'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep=2460859&-ra=1&-dec=-2&-rd=0.5&-mime=votable&-output=object&-from=LoopTheDifference',
    )
  })
})

describe('query radius', () => {
  it('covers 0.75 of the view, at least the frame size, at most 1°', () => {
    expect(catalogRadius(0.4, 0.2)).toBeCloseTo(0.3)
    expect(catalogRadius(0.1, 0.2)).toBe(0.2)
    expect(catalogRadius(5, 0.2)).toBe(1)
  })
})

describe('frame date', () => {
  it('turns MJD into a UTC calendar date', () => {
    expect(isoDate(51544.5)).toBe('2000-01-01')
    expect(isoDate(60858.9)).toBe('2025-07-02')
  })
})

describe('Gaia proper motion', () => {
  // Barnard's Star, Gaia DR3 at J2016.0.
  const barnard = { ra: 269.44850252543, dec: 4.73942005111, pmRa: -801.551, pmDec: 10362.394 }
  const mjd2025_5 = 51544.5 + 25.5 * 365.25

  it('moves Barnard\'s Star ~98.4″ north by 2025.5', () => {
    const { ra, dec } = propagateGaia(barnard, mjd2025_5)
    expect((dec - barnard.dec) * 3600).toBeCloseTo(98.44, 1)
    const dRaCosDec = (ra - barnard.ra) * 3600 * Math.cos((barnard.dec * Math.PI) / 180)
    expect(dRaCosDec).toBeCloseTo(-7.61, 1)
  })

  it('leaves the position unchanged at J2016.0', () => {
    const { ra, dec } = propagateGaia(barnard, 51544.5 + 16 * 365.25)
    expect(ra).toBeCloseTo(barnard.ra, 10)
    expect(dec).toBeCloseTo(barnard.dec, 10)
  })
})
