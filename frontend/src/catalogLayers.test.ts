import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogCache,
  catalogRadius,
  fetchVotable,
  gaiaSources,
  gaiaUrl,
  isoDate,
  layerStatus,
  parseVotableRows,
  propagateGaia,
  simbadSources,
  sourceName,
  simbadUrl,
  skybotUrl,
  snapEpoch,
  type View,
  wiseUrl,
} from './catalogLayers'

describe('catalogue URLs', () => {
  it('encodes the cone centre with %20, never +', () => {
    for (const url of [gaiaUrl(269.45, 4.69, 0.2), wiseUrl(269.45, 4.69, 0.2)]) {
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

  it('asks the second VizieR mirror with the same parameters', () => {
    expect(gaiaUrl(1, -2, 0.5, 'https://vizier.idia.ac.za')).toBe(
      gaiaUrl(1, -2, 0.5).replace('vizier.cfa.harvard.edu', 'vizier.idia.ac.za'),
    )
    expect(wiseUrl(1, -2, 0.5, 'https://vizier.idia.ac.za')).toMatch(
      /^https:\/\/vizier\.idia\.ac\.za\/viz-bin\/votable\?-source=II\/328\/allwise&/,
    )
  })

  it('asks SIMBAD TAP for the 500 brightest objects in the cone (V, else G), encoded', () => {
    const url = simbadUrl(1, -2, 0.5)
    expect(url).toBe(
      "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=votable/td&query=SELECT%20TOP%20500%20main_id%2C%20ra%2C%20dec%2C%20otype%2C%20pmra%2C%20pmdec%20FROM%20basic%20LEFT%20JOIN%20allfluxes%20ON%20basic.oid%20%3D%20allfluxes.oidref%20WHERE%20CONTAINS(POINT('ICRS'%2C%20ra%2C%20dec)%2C%20CIRCLE('ICRS'%2C%201%2C%20-2%2C%200.5))%20%3D%201%20ORDER%20BY%20V%2C%20G",
    )
    expect(decodeURIComponent(url.split('query=')[1])).toBe(
      "SELECT TOP 500 main_id, ra, dec, otype, pmra, pmdec FROM basic LEFT JOIN allfluxes ON basic.oid = allfluxes.oidref WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', 1, -2, 0.5)) = 1 ORDER BY V, G",
    )
  })

  it('asks SkyBoT at the frame epoch as Julian Date, for the Earth’s centre like the mark check', () => {
    expect(skybotUrl(1, -2, 0.5, 60858.5)).toBe(
      'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep=2460859&-ra=1&-dec=-2&-rd=0.5&-mime=votable&-output=object&-observer=500&-from=LoopTheDifference',
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

  it('reads SkyBoT rows with the vot: prefix and its "no object found" error as empty', () => {
    expect(
      parseVotableRows(
        '<vot:VOTABLE><vot:TABLEDATA><vot:TR><vot:TD>A</vot:TD><vot:TD>1</vot:TD></vot:TR></vot:TABLEDATA></vot:VOTABLE>',
      ),
    ).toEqual([['A', '1']])
    expect(
      parseVotableRows(
        '<vot:VOTABLE><vot:INFO name="QUERY_STATUS" value="ERROR">No solar system object was found in the requested FOV</vot:INFO><vot:TABLE nrows="0"/></vot:VOTABLE>',
      ),
    ).toEqual([])
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

describe('SIMBAD sources at the frame epoch', () => {
  const mjd2025_5 = 51544.5 + 25.5 * 365.25

  it("moves Barnard's Star from J2000 by its proper motion and keeps name and type", () => {
    const [star] = simbadSources(
      [["NAME Barnard's star", '269.45207511', '4.69339088', 'BY*', '-801.551', '10362.394']],
      mjd2025_5,
    )
    expect((star.dec - 4.69339088) * 3600).toBeCloseTo(264.24, 1)
    const cosDec = Math.cos((4.69339088 * Math.PI) / 180)
    expect((star.ra - 269.45207511) * 3600 * cosDec).toBeCloseTo(-20.44, 1)
    expect(star.data).toMatchObject({ main_id: "NAME Barnard's star", otype: 'BY*' })
  })

  it('stays at J2000 for the J2000 epoch (no frames yet)', () => {
    const [star] = simbadSources(
      [['x', '269.45207511', '4.69339088', 'BY*', '-801.551', '10362.394']],
      51544.5,
    )
    expect(star).toMatchObject({ ra: 269.45207511, dec: 4.69339088 })
  })

  it('keeps the J2000 position without proper motion and drops rows without a position', () => {
    const sources = simbadSources(
      [
        ['M 31', '10.68', '41.27', 'G', '', ''],
        ['x', '', '', '', '', ''],
      ],
      mjd2025_5,
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ ra: 10.68, dec: 41.27 })
  })
})

describe('marker name on hover', () => {
  it('takes the name column of each catalogue', () => {
    expect(sourceName({ main_id: "NAME Barnard's star", ra: '1' })).toBe("NAME Barnard's star")
    expect(sourceName({ Num: '1', Name: 'Ceres' })).toBe('Ceres')
    expect(sourceName({ AllWISE: 'J175747.37+044601.2' })).toBe('J175747.37+044601.2')
    expect(sourceName({ Source: '4472832130942575872' })).toBe('4472832130942575872')
    expect(sourceName(undefined)).toBe('')
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

  it('hands back the same source array for the same view and epoch, a new one for a new epoch', async () => {
    const cache = catalogCache(async (_view: unknown, epoch: number) => [{ epoch }])
    const first = await cache.load(view, 60900)
    expect(await cache.load(view, 60900)).toBe(first)
    expect(cache.peek(view, 60900)).toBe(first)
    const next = await cache.load(view, 61100)
    expect(next).not.toBe(first)
    expect(next).toEqual([{ epoch: 61100 }])
  })

  it('remembers a failure until the view changes', async () => {
    const load = vi.fn(async () => null)
    const cache = catalogCache(load)
    expect(await cache.load(view, 60900)).toBeNull()
    expect(cache.peek(view, 60900)).toBeNull()
    await cache.load(view, 60900)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('aborts the running request when the view changes', async () => {
    const signals: AbortSignal[] = []
    const cache = catalogCache(async (_v: View, _e: number, cancel: AbortSignal) => {
      signals.push(cancel)
      return 'catalogue'
    })
    await cache.load(view, 60900)
    expect(signals[0].aborted).toBe(false)
    cache.peek({ ...view, ra: 270 }, 60900)
    expect(signals[0].aborted).toBe(true)
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
    expect(load).toHaveBeenLastCalledWith(moved, 60900, expect.any(AbortSignal))
    expect(cache.peek(moved, 61100)).toBeUndefined()
  })
})

describe('layer status', () => {
  it('tells an empty field from a failed service', () => {
    expect(layerStatus({})).toBe('ready')
    expect(layerStatus('none')).toBe('none')
    expect(layerStatus(null)).toBe('unavailable')
  })
})

describe('catalogue download', () => {
  afterEach(() => vi.unstubAllGlobals())
  const ok = '<VOTABLE><TABLEDATA><TR><TD>1</TD></TR></TABLEDATA></VOTABLE>'
  const busy =
    '<VOTABLE><INFO name="QUERY_STATUS" value="ERROR">The database is not currently reachable</INFO></VOTABLE>'

  it('tries the next mirror only after the first answer failed, one request at a time', async () => {
    let inFlight = 0
    let most = 0
    const fetch = vi.fn(async (url: string) => {
      most = Math.max(most, ++inFlight)
      await Promise.resolve()
      inFlight--
      return new Response(url === 'a' ? busy : ok)
    })
    vi.stubGlobal('fetch', fetch)
    expect((await fetchVotable(['a', 'b'], 1000)).rows).toEqual([['1']])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['a', 'b'])
    expect(most).toBe(1)
  })

  it('fails when every attempt failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    )
    await expect(fetchVotable(['a', 'a'], 1000)).rejects.toThrow('HTTP 503')
  })

  it('stops a running request and skips the next attempt when cancelled', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    )
    vi.stubGlobal('fetch', fetch)
    const cancel = new AbortController()
    const answer = fetchVotable(['a', 'b'], 60_000, cancel.signal)
    cancel.abort()
    await expect(answer).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
