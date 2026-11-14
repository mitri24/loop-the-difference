import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../candidate'
import { NOT_LISTED, NOT_REACHABLE, parseSkybot, type SkybotAnswer } from '../knownObjects'
import { KnownObjectCheck } from './KnownObjectCheck'

const PLUTO_JSON = '[{"Num":134340,"Name":"Pluto","Class":"KBO>Resonant>3:2","d (arcsec)":0.108,"dRA (arcsec\\/h)":0.7975,"dDEC (arcsec\\/h)":-0.3063}]'
// Pluto in frame 11 snaps to a G 19.97 Gaia star: a chance coincidence.
const mark = (obs_id: string, catalog_id: string | null): Mark => ({
  obs_id, mjd: 61156.32238, date: '2026-05-01T07:44:13Z', ra: 308.525475, dec: -22.891424, sigma_arcsec: 1,
  source: { ra: 308.525475, dec: -22.891424, x: 0, y: 0, peak_mjy_sr: 1, snr: 50, match: catalog_id ? 'gaia' : 'none',
    catalog_id, separation_arcsec: 0.4, catalog_mag: 19.97, catalog_band: 'G' },
})
const render = (marks: Mark[], initial: SkybotAnswer[] = []) => renderToStaticMarkup(
  <KnownObjectCheck marks={marks} epochs={[]} motion={null} detector={3} target="Pluto" initial={initial} />,
)

describe('KnownObjectCheck', () => {
  it('before the check: unverified, links at mark A, default verdict, credits', () => {
    const html = render([mark('a', null)])
    expect(html).toContain('Unverified candidate – needs verification')
    expect(html).toContain('Check known objects')
    expect(html).toContain('ra=308.52547&amp;dec=-22.89142')
    expect(html).toContain('SIMBAD and VizieR list J2000 positions; a fast-moving star can sit far away')
    expect(html).toMatch(/checked="" value="needs follow-up"/)
    expect(html).toContain('Your verdict: needs follow-up')
    expect(html).toContain('SkyBoT, IMCCE / Observatoire de Paris; NASA/JPL SBIdent')
    expect(html).not.toMatch(/confirmed/i)
  })

  it('a known body ranks above a catalogue star', () => {
    const pluto = { bodies: parseSkybot(200, PLUTO_JSON) }
    const html = render([mark('a', '6845'), mark('b', '6845')], [pluto, pluto])
    expect(html).toContain('Possible known Solar System body')
    expect(html).toContain('◇ possible known Solar System body: (134340) Pluto · 0.1″ · moves 0.85″/h · class KBO')
    expect(html).toContain('position coincides with Gaia DR3 6845 (0.4″) – a positional coincidence')
    expect(html).toContain('SkyBoT: 2 of 2 checked')
    expect(render([mark('a', '6845'), mark('b', '6845')])).toContain('Catalogue star at this position')
  })

  it('tells an empty field from an unreachable service', () => {
    const html = render([mark('a', null), mark('b', null)], [{ bodies: [] }, { error: NOT_REACHABLE }])
    expect(html).toContain(NOT_LISTED)
    expect(html).toContain(NOT_REACHABLE)
    expect(html).toContain('Unverified candidate')
  })
})
