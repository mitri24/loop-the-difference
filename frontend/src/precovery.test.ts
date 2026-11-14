import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { Mark } from './candidate'
import { Precovery } from './components/Precovery'
import { cutoutDeg, historicalRows, NOT_A_LINE, visitRows, yearToMjd } from './precovery'
import { possibleTrack, predict } from './track'
import type { Observation } from './types'

const CENTRE = { ra: 150, dec: 20 }
const mark = (mjd: number, dec: number, sigma: number): Mark =>
  ({ obs_id: `m${mjd}`, mjd, date: '', ra: CENTRE.ra, dec, sigma_arcsec: sigma })
// A star moving 8″/yr due north: 4″ over half a year.
const STAR = [mark(61000, 20, 0.3), mark(61000 + 365.25 / 2, 20 + 4 / 3600, 0.3)]
const obs = (obs_id: string, mjd: number, detector = 3): Observation => ({
  obs_id, detector, mjd, date: `2026-01-0${obs_id.length}T12:34:56Z`, wavelength_min_um: 1, wavelength_max_um: 2,
  access_url: `https://irsa.ipac.caltech.edu/ibe/data/spherex/${obs_id}.fits`,
})

describe('where to look', () => {
  const star = possibleTrack(STAR, CENTRE, [])!

  it('lists every visit on the blink detector, newest first, with the prediction at its own time', () => {
    const rows = visitRows([obs('a', 60900), obs('bb', 61300), obs('ccc', 61100, 4)], 3, ['a'], star, STAR)
    expect(star.regime).toBe('stellar')
    expect(rows.map((r) => [r.source, r.inBlink])).toEqual([['bb', false], ['a', true]])
    expect(rows[0].when).toBe('2026-01-02 12:34 UTC')
    expect((rows[0].at!.dec - 20) * 3600).toBeCloseTo(4 + (8 * (61300 - 61000 - 365.25 / 2)) / 365.25, 3)
    const at = predict(star.fit, 61300)
    const cutout = `https://irsa.ipac.caltech.edu/ibe/data/spherex/bb.fits?center=${at.ra.toFixed(6)},${at.dec.toFixed(6)}&size=${cutoutDeg(at.radius_arcsec).toFixed(4)}`
    expect(rows[0].links.map((l) => l.url)).toEqual([
      cutout, `https://irsa.ipac.caltech.edu/irsaviewer/?api=image&url=${encodeURIComponent(cutout)}`,
    ])
  })

  it('keeps a fast mover to one day around the marks and says why elsewhere', () => {
    const fast = [mark(61000, 20, 1), mark(61000.5, 20 + 10 / 3600, 1)]
    const track = possibleTrack(fast, CENTRE, [])!
    expect(track.regime).toBe('fast')
    const rows = visitRows([obs('a', 61001.4), obs('b', 61001.6), obs('c', 60998.9)], 3, [], track, fast)
    expect(rows.map((r) => [r.source, r.note])).toEqual([['b', NOT_A_LINE], ['a', null], ['c', NOT_A_LINE]])
    expect(rows[0].links).toEqual([])
    expect(historicalRows(track, 3)).toEqual([])
  })

  it('grows the search radius away from the marks and stops linking beyond 0.5°', () => {
    const near = predict(star.fit, 61100).radius_arcsec
    expect(predict(star.fit, yearToMjd(1991)).radius_arcsec).toBeGreaterThan(near)
    expect(cutoutDeg(0)).toBe(0.02)
    expect(cutoutDeg(36)).toBeCloseTo(0.04, 10)
    expect(cutoutDeg(3600)).toBe(0.5)
    const loose = [mark(61000, 20, 40), mark(61001, 20 + 400 / 3600, 40)]
    const [far] = visitRows([obs('a', 63000)], 3, [], { ...possibleTrack(loose, CENTRE, [])!, regime: 'stellar' }, loose)
    expect(far.note).toMatch(/^Too uncertain to check \(±\d+′\)$/)
    expect(far.links).toEqual([])
  })

  it('links WiseView and the two POSS plates at the propagated positions for a star', () => {
    const [wise, poss2, poss1] = historicalRows(star, 3)
    const at = (year: number) => predict(star.fit, yearToMjd(year))
    const r = (v: number) => Number(v.toFixed(6))
    const arcmin = (year: number) => Number((cutoutDeg(at(year).radius_arcsec) * 60).toFixed(2))
    expect(wise.links[0].url).toBe(`http://byw.tools/wiseview#ra=${at(2017).ra.toFixed(5)}&dec=${at(2017).dec.toFixed(5)}&size=176&band=3`)
    expect(poss2.links[0].url).toBe(`https://archive.stsci.edu/cgi-bin/dss_search?v=poss2ukstu_red&r=${r(at(1991).ra)}&d=${r(at(1991).dec)}&e=J2000&h=${arcmin(1991)}&w=${arcmin(1991)}&f=gif&c=none&fov=NONE&v3=`)
    expect(poss1.links[0].url).toContain('v=poss1_red&')
    expect(poss1.links[0].label).toContain('plate date inside the file; time not printed')
    expect((at(1953).dec - 20) * 3600).toBeCloseTo(2 - (8 * (61000 + 365.25 / 4 - yearToMjd(1953))) / 365.25, 2)
  })

  it('keeps the plate rows for no significant motion and says when POSS-I does not reach the field', () => {
    const still = [mark(61000, -40, 1), mark(61100, -40, 1)].map((m) => ({ ...m, ra: 10 }))
    const track = possibleTrack(still, { ra: 10, dec: -40 }, [])!
    expect(track.regime).toBe('none')
    const [, poss2, poss1] = historicalRows(track, 3)
    expect(poss2.links[0].url).toContain('v=poss2ukstu_red&')
    expect(poss1).toMatchObject({ note: 'POSS-I covers only north of −30°', links: [] })
  })

  it('says so when the archive lists no visit on the detector', () => {
    const html = renderToStaticMarkup(createElement(Precovery, {
      track: star, marks: STAR, observations: [obs('a', 60900, 4)], inBlink: [], detector: 3, followsTarget: null,
    }))
    expect(html).toContain('The archive lists no SPHEREx visit of this field on D3.')
  })

  it('renders the rows and points to the Gaia track when the marks follow the target', () => {
    const html = renderToStaticMarkup(createElement(Precovery, {
      track: star, marks: STAR, observations: [obs('a', 60900)], inBlink: ['a'], detector: 3, followsTarget: 'Barnard’s Star',
    }))
    expect(html).toContain('Predicted positions to check')
    expect(html).toContain('Your marks follow Barnard’s Star')
    expect(html).toContain('in the blink')
    expect(html).toContain('Cutout at the predicted position (FITS, IRSA, ~4 MB+)')
    expect(html).toContain('WiseView blinks 2010–2024')
    expect(html).not.toMatch(/found/i)
  })
})
