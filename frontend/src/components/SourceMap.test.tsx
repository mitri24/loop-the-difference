import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DetectedSource } from '../types'
import { SourceMap } from './SourceMap'

const star = (i: number, over: Partial<DetectedSource> = {}): DetectedSource => ({
  ra: 120 + i * 0.01, dec: 10, x: 0, y: 0, peak_mjy_sr: 1 + (i % 5) * 0.1, snr: 30, match: 'gaia',
  catalog_id: `Gaia DR3 ${i}`, separation_arcsec: 0.4, catalog_mag: 14, catalog_band: 'G', ...over,
})

describe('SourceMap', () => {
  it('lists the unusual source first, with the honest wording and a table', () => {
    const odd = star(99, { match: 'none', catalog_id: null, catalog_mag: null, catalog_band: null, separation_arcsec: null, peak_mjy_sr: 9 })
    const frames = [0, 1].map(() => ({ sources: [...Array.from({ length: 8 }, (_, i) => star(i)), odd] }))
    const html = renderToStaticMarkup(<SourceMap frames={frames} pixelScaleArcsec={6.15} onSelect={() => {}} />)

    expect(html).toContain('linear projection – few sources')
    const checkFirst = html.slice(html.indexOf('Check first'))
    expect(checkFirst.indexOf('No catalogue match – needs verification')).toBeLessThan(checkFirst.indexOf('Gaia DR3'))
    expect(html).toContain('the axes have no physical meaning')
    expect(html).toContain('Unusual is not new')
    expect(html).toContain('<caption>Sources, most unusual first</caption>')
    expect(html).not.toMatch(/discover|brown dwarf|new object/i)
  })

  it('rings the sources of the candidate marks', () => {
    const sources = Array.from({ length: 5 }, (_, i) => star(i))
    const marks = [{ obs_id: 'o', mjd: 1, date: '', ra: sources[2].ra, dec: 10, sigma_arcsec: 1, source: sources[2] }]
    const html = renderToStaticMarkup(<SourceMap frames={[{ sources }, { sources }]} pixelScaleArcsec={6.15} onSelect={() => {}} marks={marks} />)
    expect(html.match(/stroke="var\(--text-primary\)"/g)).toHaveLength(1)
  })

  it('says when there are too few sources', () => {
    const html = renderToStaticMarkup(<SourceMap frames={[{ sources: [star(1)] }]} pixelScaleArcsec={6.15} onSelect={() => {}} />)
    expect(html).toContain('Too few detected sources')
  })
})
