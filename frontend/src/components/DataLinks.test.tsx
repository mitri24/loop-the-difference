import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../types'
import { CheckDocsLink, DataLinks, LearnLinks } from './DataLinks'

const manifest = { ra: 133.79513, dec: -7.24515, detector: 6 }
const frame: Frame = {
  index: 0,
  url: '/api/frames/job/frame_00.png',
  obs_id: '2025W19_1B_0116_1',
  date: '2025-05-05T12:00:00Z',
  mjd: 60800.5,
  detector: 6,
  wavelength_min_um: 4.4,
  wavelength_max_um: 5.0,
  coverage: 1,
  source_url: 'https://irsa.example/cutout.fits?center=133.795130,-7.245150&size=0.2830',
  cloud_url: 'https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/file.fits',
  epoch: 0,
  n_combined: 3,
  date_end: '2025-05-06T12:00:00Z',
  masked_fraction: 0,
  wavelength_um: null,
  bandwidth_um: null,
}

const anchors = (html: string) => html.match(/<a [^>]*>/g) ?? []

describe('DataLinks', () => {
  it('opens every link in a new tab without handing over the window', () => {
    const frameAndPosition = anchors(renderToStaticMarkup(<DataLinks manifest={manifest} frame={frame} />))
    const learn = anchors(renderToStaticMarkup(<LearnLinks />))
    const links = [...frameAndPosition, ...learn]

    expect([frameAndPosition.length, learn.length]).toEqual([6, 9])
    for (const link of links) {
      expect(link).toContain('target="_blank"')
      expect(link).toContain('rel="noopener noreferrer"')
    }
  })

  it('keeps the provenance of a stacked frame next to its files', () => {
    const html = renderToStaticMarkup(<DataLinks manifest={manifest} frame={frame} />)

    expect(html).toContain('First of 3 stacked exposures: 2025W19_1B_0116_1 · D6 · 2025-05-05')
    expect(html).toContain('about 65 MB')
  })

  it('shows only the position links without a frame', () => {
    const html = renderToStaticMarkup(<DataLinks manifest={manifest} />)

    expect(html).not.toContain('Data for this frame')
    expect(html).toContain('Cross-check this position')
  })

  it('renders a documentation link only for documented checks', () => {
    expect(renderToStaticMarkup(<CheckDocsLink code="FLAGGED_PIXELS" />)).toContain('Table 16')
    expect(renderToStaticMarkup(<CheckDocsLink code="LOW_OVERLAP" />)).toBe('')
  })
})
