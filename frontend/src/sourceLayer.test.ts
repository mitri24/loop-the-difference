import { describe, expect, it } from 'vitest'
import { MATCHES, MATCH_STYLE, brightestFirst, catalogMag, countSources, sourceRow } from './sourceLayer'
import type { DetectedSource, Frame } from './types'

const source = (match: DetectedSource['match'], snr: number): DetectedSource => ({
  ra: 133.79701,
  dec: -7.25786,
  x: 52.4,
  y: 61.0,
  peak_mjy_sr: 1.234,
  snr,
  match,
  catalog_id: match === 'gaia' ? 'Gaia DR3 5756955785394371328' : null,
  separation_arcsec: match === 'gaia' ? 1.23 : null,
  catalog_mag: match === 'gaia' ? 13.298 : null,
  catalog_band: match === 'gaia' ? 'G' : null,
})

const frame: Frame = {
  index: 0,
  url: '/api/frames/abc/frame_00.png',
  obs_id: '2025W19_1B_0116_1',
  date: '2025-05-05T16:49:00Z',
  mjd: 60800.7,
  detector: 6,
  wavelength_min_um: 4.4,
  wavelength_max_um: 5.0,
  coverage: 1,
  source_url: 'https://irsa.ipac.caltech.edu/cutout.fits',
  epoch: 0,
  n_combined: 1,
  date_end: null,
  masked_fraction: 0,
  wavelength_um: 4.69,
  bandwidth_um: 0.037,
}

describe('source labels', () => {
  it('marks a catalogue match with + and no match with ×, never with a catalogue-layer shape', () => {
    expect(MATCHES.map((match) => MATCH_STYLE[match].shape)).toEqual([
      'plus',
      'plus',
      'cross',
      'cross',
    ])
    expect(MATCHES.map((match) => MATCH_STYLE[match].glyph)).toEqual(['+', '+', '×', '×'])
    for (const match of MATCHES) {
      expect(['circle', 'square', 'triangle', 'rhomb']).not.toContain(MATCH_STYLE[match].shape)
    }
  })

  it('names the catalogue or the reason in a word of its own for every label', () => {
    const words = MATCHES.map((match) => MATCH_STYLE[match].word)

    expect(new Set(words).size).toBe(4)
    expect(MATCH_STYLE.gaia.word).toContain('Gaia DR3')
    expect(MATCH_STYLE.allwise.word).toContain('AllWISE')
    expect(MATCH_STYLE.none.word).toContain('needs verification')
    expect(MATCH_STYLE.unknown.word).toContain('catalogue unavailable')
    expect(words.join(' ')).not.toMatch(/discover|confirmed|new object/i)
  })

  it('counts every label', () => {
    expect(
      countSources([source('gaia', 9), source('none', 5), source('none', 7), source('unknown', 6)]),
    ).toEqual({ detected: 4, gaia: 1, allwise: 0, none: 2, unknown: 1 })
    expect(countSources([])).toEqual({ detected: 0, gaia: 0, allwise: 0, none: 0, unknown: 0 })
  })

  it('lists the brightest first without reordering the manifest', () => {
    const sources = [source('none', 5), source('gaia', 30), source('allwise', 12)]

    expect(brightestFirst(sources).map((s) => s.snr)).toEqual([30, 12, 5])
    expect(sources.map((s) => s.snr)).toEqual([5, 30, 12])
  })

  it('keeps the catalogue evidence and the frame provenance in the sky table', () => {
    const row = sourceRow(source('gaia', 30), frame)

    expect(row).toMatchObject({
      label: 'Gaia DR3 match',
      catalogue: 'Gaia DR3 5756955785394371328',
      separation: '1.2 arcsec',
      magnitude: 'G 13.30',
      obs_id: '2025W19_1B_0116_1',
      date: '2025-05-05T16:49:00Z',
      detector: 'D6',
    })
    expect(catalogMag(source('none', 5))).toBeNull()
    expect(sourceRow(source('none', 5), frame).catalogue).toBe('–')
  })
})
