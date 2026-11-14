import { describe, expect, it, vi } from 'vitest'
import {
  catalogCache,
  catalogRadius,
  gaiaSources,
  gaiaUrl,
  isoDate,
  parseVotableRows,
  propagateGaia,
  simbadUrl,
  skybotUrl,
  snapEpoch,
  wiseUrl,
} from './catalogLayers'

describe('catalogue URLs', () => {
  it('encodes the cone centre with %20, never +', () => {
    for (const url of [
      gaiaUrl(269.45, 4.69, 0.2),
      wiseUrl(269.45, 4.69, 0.2),
      simbadUrl(269.45, 4.69, 0.2),
    ]) {
      expect(url).toContain('269.45%204.69')
      expect(url).not.toContain('+')
    }
  })

  it('asks Gaia DR3 for the columns the propagation needs', () => {
    expect(gaiaUrl(1, -2, 0.5)).toBe(
      'https://vizier.cfa.harvard.edu/viz-bin/votable?-source=I/355/gaiadr3&-c=1%20-2&-c.rd=0.5&-out.max=500&-sort=Gmag&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag',
    )
  })

  it('asks AllWISE for id, position and W1/W2', () => {
    expect(wiseUrl(1, -2, 0.5)).toBe(
      'https://vizier.cfa.harvard.edu/viz-bin/votable?-source=II/328/allwise&-c=1%20-2&-c.rd=0.5&-out.max=500&-sort=W1mag&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag',
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

describe('epoch of a frame', () => {
  it('reuses a known epoch within a day and opens a new one beyond', () => {
    expect(snapEpoch([], 60900.2)).toBe(60900.2)
    expect(snapEpoch([60900.2], 60901.1)).toBe(60900.2)
    expect(snapEpoch([60900.2], 61100)).toBe(61100)
    expect(snapEpoch([60900.2, 61100], 61099.5)).toBe(61100)
  })
})

describe('Gaia proper motion', () => {
  // Barnard's Star, Gaia DR3 at J2016.0.
  const barnard = { ra: 269.44850252543, dec: 4.73942005111, pmRa: -801.551, pmDec: 10362.394 }
  const mjd2025_5 = 51544.5 + 25.5 * 365.25

  it("moves Barnard's Star ~98.4″ north by 2025.5", () => {
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

describe('VOTable rows', () => {
  const votable = (rows: string) =>
    `<?xml version="1.0"?><VOTABLE><RESOURCE><TABLE><DATA><TABLEDATA>${rows}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`

  it('reads cells in field order, empty cells as empty strings', () => {
    expect(
      parseVotableRows(
        votable('<TR><TD>1</TD><TD/><TD> 3 </TD></TR><TR><TD>4</TD><TD></TD><TD>6</TD></TR>'),
      ),
    ).toEqual([
      ['1', '', '3'],
      ['4', '', '6'],
    ])
  })

  it('returns no rows for an empty answer', () => {
    expect(parseVotableRows('<VOTABLE><RESOURCE/></VOTABLE>')).toEqual([])
  })

  it('throws on an error answer or something that is not a VOTable', () => {
    expect(() => parseVotableRows('<html>busy</html>')).toThrow()
    expect(() =>
      parseVotableRows('<VOTABLE><INFO name="QUERY_STATUS" value="ERROR">bad</INFO></VOTABLE>'),
    ).toThrow()
  })
})

describe('Gaia sources at the frame epoch', () => {
  const mjd2025_5 = 51544.5 + 25.5 * 365.25

  it('moves stars with proper motion and keeps id and magnitude', () => {
    const [star] = gaiaSources(
      [
        [
          '4472832130942575872',
          '269.44850252543',
          '4.73942005111',
          '546.9759',
          '-801.551',
          '10362.394',
          '8.1940',
        ],
      ],
      mjd2025_5,
    )
    expect((star.dec - 4.73942005111) * 3600).toBeCloseTo(98.44, 1)
    expect(star.data).toMatchObject({ Source: '4472832130942575872', Gmag: '8.1940' })
  })

  it('keeps the J2016.0 position without proper motion and drops rows without a position', () => {
    const sources = gaiaSources(
      [
        ['1', '10.5', '-20.25', '', '', '', '19.1'],
        ['2', '', '', '', '', '', ''],
      ],
      mjd2025_5,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ ra: 10.5, dec: -20.25 })
  })
})

describe('catalogue cache', () => {
  const view = { ra: 269.45, dec: 4.69, r: 0.2 }
  const slow = () => vi.fn(async (_view: unknown, epoch: number) => `catalogue ${epoch}`)

  it('asks once per epoch while the player blinks between two epochs', async () => {
    const load = slow()
    const cache = catalogCache(load)
    const shown: (string | null)[] = []
    for (const epoch of [60900, 61100, 60900, 61100, 60900]) {
      void cache.load(view, epoch).then((catalog) => shown.push(catalog))
    }
    await cache.load(view, 61100)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.peek(view, 60900)).toBe('catalogue 60900')
    expect(cache.peek(view, 61100)).toBe('catalogue 61100')
    await cache.load(view, 60900)
    expect(load).toHaveBeenCalledTimes(2)
    expect(shown).toHaveLength(5)
  })

  it('remembers a failure until the view changes', async () => {
    const load = vi.fn(async () => null)
    const cache = catalogCache(load)
    expect(await cache.load(view, 60900)).toBeNull()
    expect(cache.peek(view, 60900)).toBeNull()
    await cache.load(view, 60900)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('starts again for a new view and skips requests queued for the old one', async () => {
    const load = slow()
    const cache = catalogCache(load)
    expect(await cache.load(view, 60900)).toBe('catalogue 60900')
    const skipped = cache.load(view, 61100)
    const moved = { ...view, ra: 270 }
    expect(cache.peek(moved, 60900)).toBeUndefined()
    const fresh = cache.load(moved, 60900)
    expect(await skipped).toBeNull()
    expect(await fresh).toBe('catalogue 60900')
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith(moved, 60900)
    expect(cache.peek(moved, 61100)).toBeUndefined()
  })
})
