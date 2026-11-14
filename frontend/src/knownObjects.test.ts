import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mark } from './candidate'
import {
  NOT_REACHABLE, bodyText, checkMarks, followsTarget, matchBodies, parseSkybot, sameCatalogueSource, sbidentMatches, skybotCone,
  skybotUrl,
} from './knownObjects'
import type { DetectedSource, ProperMotion, SmallBodyEpoch } from './types'

// Recorded from SkyBoT on 14 Nov 2026 (cone 0.01°, observer 500), trimmed to the fields we read.
const PLUTO_JSON = '[{"Num":134340,"Name":"Pluto","RA (hms)":"20 34 6.1168","DEC (dms)":"-22 53 29.026","Class":"KBO>Resonant>3:2","VMag (mag)":15.2,"Err (arcsec)":0.009,"d (arcsec)":0.108,"dRA (arcsec\\/h)":0.7975,"dDEC (arcsec\\/h)":-0.3063,"dg (ua)":35.47577476689,"dh (ua)":35.50087246291}]'
const PSYCHE_JSON = '[{"Num":16,"Name":"Psyche","RA (hms)":"04 53 44.5702","DEC (dms)":"+19 24 1.685","Class":"MB>Outer","VMag (mag)":11.4,"Err (arcsec)":0.003,"d (arcsec)":2.012,"dRA (arcsec\\/h)":41.817,"dDEC (arcsec\\/h)":2.0969,"dg (ua)":2.50955671527,"dh (ua)":2.57619034766}]'

const plutoMark: Mark = {
  obs_id: 'a', mjd: 2461156.82238 - 2400000.5, date: '2026-05-01T07:44:13Z', ra: 308.525475, dec: -22.891424, sigma_arcsec: 1,
}

describe('SkyBoT', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks at the mark time as JD, with a 36″ cone, all fields, geocentric', () => {
    const url = new URL(skybotUrl(plutoMark))
    expect(url.searchParams.get('-ep')).toBe('2461156.82238')
    expect(url.searchParams.get('-rd')).toBe('0.01')
    expect(url.searchParams.get('-output')).toBe('all')
    expect(url.searchParams.get('-mime')).toBe('json')
    expect(url.searchParams.get('-observer')).toBe('500')
  })

  it('reads Pluto and Psyche', () => {
    const [pluto] = parseSkybot(200, PLUTO_JSON)
    expect(bodyText(pluto)).toBe('(134340) Pluto · 0.1″ · moves 0.85″/h · class KBO')
    const [psyche] = parseSkybot(200, PSYCHE_JSON)
    expect(bodyText(psyche)).toBe('(16) Psyche · 2.0″ · moves 41.9″/h · class MB')
  })

  it('reads 204 as an empty field', () => {
    expect(parseSkybot(204, '')).toEqual([])
  })

  it('splits possible (≤ max(10″, 2σ)) from nearby bodies', () => {
    const body = (sepArcsec: number) => ({ name: `b${sepArcsec}`, sepArcsec, rate: 1, kind: 'MB' })
    expect(matchBodies([body(9), body(11), body(30)], 1)).toEqual({ possible: [body(9)], nearby: [body(11), body(30)] })
    expect(matchBodies([body(11)], 6).possible).toEqual([body(11)])
  })

  it('answers a 204 as no body and a network error as not reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await skybotCone(plutoMark, new AbortController().signal)).toEqual({ bodies: [] })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await skybotCone(plutoMark, new AbortController().signal)).toEqual({ error: NOT_REACHABLE })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    expect(await skybotCone(plutoMark, new AbortController().signal)).toEqual({ error: NOT_REACHABLE })
  })
})

describe('checkMarks', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks one mark after the other and stops once aborted', async () => {
    const urls: string[] = []
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (urls.length === 2) controller.abort()
      return new Response(PLUTO_JSON, { status: 200 })
    }))
    const answers: unknown[] = []
    const b = { ...plutoMark, obs_id: 'b', mjd: plutoMark.mjd + 1 }
    await checkMarks([plutoMark, b, { ...b, obs_id: 'c' }], controller.signal, (a) => answers.push(a))
    expect(urls).toHaveLength(2)
    expect(new URL(urls[1]).searchParams.get('-ep')).toBe(String(b.mjd + 2400000.5))
    expect(answers).toHaveLength(1)
  })
})

describe('other evidence', () => {
  const epoch: SmallBodyEpoch = {
    mjd: plutoMark.mjd - 0.5, date: '2026-04-30T19:44:13Z', error: null, source_url: 'https://ssd-api.jpl.nasa.gov/sb_ident.api',
    bodies: [{ name: '134340 Pluto', ra: 308.525475 - 0.0001, dec: -22.891424 + 6 / 3600, vmag: 15.2, ra_rate: 0, dec_rate: -0.5, distance_arcsec: 3 }],
  }

  it('moves SBIdent bodies to the mark time and matches them', () => {
    const [match] = sbidentMatches([epoch], plutoMark)!
    expect(match.name).toBe('134340 Pluto')
    expect(match.sepArcsec).toBeLessThan(10)
    expect(sbidentMatches([{ ...epoch, mjd: plutoMark.mjd - 2 }], plutoMark)).toBeNull()
  })

  it('names a target star whose Gaia motion both marks follow', () => {
    const star: ProperMotion = { source_id: '4472832130942575872', ra: 269.44850, dec: 4.73942, ref_epoch: 2016, pmra_mas_yr: -801.551, pmdec_mas_yr: 10362.394, parallax_mas: 546.976 }
    // Barnard's Star moves 10.4″/yr: J2016 → 2026.3 is about 107″ north.
    const at = (mjd: number, dec: number): Mark => ({ obs_id: String(mjd), mjd, date: '', ra: 269.44620, dec, sigma_arcsec: 1 })
    expect(followsTarget(star, [at(61160, 4.73942 + 107 / 3600), at(61340, 4.73942 + 112 / 3600)])).toBe(true)
    expect(followsTarget(star, [at(61160, 4.73942), at(61340, 4.73942)])).toBe(false)
    expect(followsTarget(null, [at(61160, 4.73942)])).toBe(false)
  })

  it('counts a catalogue star only when every mark snapped to the same source', () => {
    const src = (catalog_id: string | null): DetectedSource => ({
      ra: 0, dec: 0, x: 0, y: 0, peak_mjy_sr: 1, snr: 50, match: catalog_id ? 'gaia' : 'none', catalog_id,
      separation_arcsec: 0.4, catalog_mag: 19.97, catalog_band: 'G',
    })
    const m = (id: string | null): Mark => ({ ...plutoMark, source: src(id) })
    expect(sameCatalogueSource([m('1'), m('1')])).toBe(true)
    expect(sameCatalogueSource([m('1'), m(null)])).toBe(false)
    expect(sameCatalogueSource([plutoMark])).toBe(false)
  })
})
