import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DetectedSource, Frame } from '../types'
import { SourceList } from './SourceList'

const source = (match: DetectedSource['match'], snr: number, ra = 133.8): DetectedSource => ({
  ra,
  dec: -7.25,
  x: 10,
  y: 20,
  peak_mjy_sr: 0.5,
  snr,
  match,
  catalog_id: match === 'allwise' ? 'AllWISE J085510.83-071442.5' : null,
  separation_arcsec: match === 'allwise' ? 2.04 : null,
  catalog_mag: match === 'allwise' ? 13.89 : null,
  catalog_band: match === 'allwise' ? 'W1' : null,
})

const frame = (sources?: DetectedSource[]): Frame => ({
  index: 2,
  url: '/api/frames/abc/frame_02.png',
  obs_id: '2025W46_2A_0226_1',
  date: '2025-11-14T13:47:52Z',
  mjd: 60993.57,
  detector: 6,
  wavelength_min_um: 4.4,
  wavelength_max_um: 5.0,
  coverage: 1,
  source_url: 'https://irsa.ipac.caltech.edu/cutout.fits',
  epoch: 1,
  n_combined: 1,
  date_end: null,
  masked_fraction: 0,
  wavelength_um: 4.69,
  bandwidth_um: 0.037,
  sources,
})

const render = (f: Frame | null, maxRows?: number) =>
  renderToStaticMarkup(<SourceList frame={f} onSelect={() => undefined} maxRows={maxRows} />)

describe('SourceList', () => {
  it('counts, explains every shape with a word and names the frame', () => {
    const html = render(frame([source('allwise', 8), source('none', 20, 133.81)]))

    expect(html).toContain('2 sources detected (≥ 5σ)')
    expect(html).toContain('Frame 3: 2025W46_2A_0226_1 · 2025-11-14 UTC · detector D6')
    expect(html).toContain('No catalogue match – needs verification: <strong>1</strong>')
    expect(html).toContain('AllWISE match: <strong>1</strong>')
    expect(html).toContain('Gaia DR3 match: <strong>0</strong>')
    expect(html).toContain('Unknown – catalogue unavailable: <strong>0</strong>')
    expect(html).toContain('AllWISE J085510.83-071442.5 · 2.0″ away · W1 13.89')
    expect(html).toContain('it is not a discovery')
    expect(html).not.toMatch(/confirmed|new object|planet x/i)
  })

  it('lists the brightest first, each row a button, and says when rows are cut', () => {
    const html = render(frame([source('none', 6, 1), source('none', 40, 2), source('none', 9, 3)]), 2)

    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html.indexOf('RA 2.00000°')).toBeLessThan(html.indexOf('RA 3.00000°'))
    expect(html).not.toContain('RA 1.00000°')
    expect(html).toContain('Showing the 2 brightest of 3.')
  })

  it('has honest empty states', () => {
    expect(render(null)).toContain('Sources appear once frames are loaded.')
    expect(render(frame())).toContain('prepared before source detection existed')
    expect(render(frame([]))).toContain('No point source above 5σ in this frame.')
  })
})
