import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../types'
import { FrameDetails } from './FrameDetails'

const frame: Frame = {
  index: 1,
  url: '/api/frames/job/frame_1.png',
  obs_id: 'obs-1',
  date: '2026-05-01T10:00:30Z',
  mjd: 61161.4,
  detector: 3,
  wavelength_min_um: 1.6,
  wavelength_max_um: 1.7,
  coverage: 0.96,
  source_url: 'https://irsa.example/obs-1',
  cloud_url: 'https://s3.example/obs-1.fits',
  epoch: 1,
  n_combined: 1,
  date_end: null,
  masked_fraction: 0.012,
  wavelength_um: 1.65,
  bandwidth_um: 0.04,
}
const grid = { ra: 10, dec: 20, size_deg: 0.05, pixel_scale_arcsec: 6.15, collection: 'spherex_dr1' }

describe('FrameDetails', () => {
  it('shows the essentials by default and keeps the rest behind All details, with provenance', () => {
    const html = renderToStaticMarkup(<FrameDetails frame={frame} index={1} count={8} letter="B" grid={grid} motion={null} />)
    expect(html).toContain('Frame 2 of 8<span class="frame-letter"> · B</span>')
    expect(html).toContain('<dd>2026-05-01 10:00:30 UTC</dd>')
    expect(html).toContain('<dd>Individual observation</dd>')
    expect(html).toContain('<dd>D3 · λ 1.65 ± 0.02 µm</dd>')
    expect(html).toContain('96 % covered · 1.2 % masked')
    expect(html).toContain('SPHEREx DR1')
    const more = html.indexOf('<summary>All details</summary>')
    expect(more).toBeGreaterThan(html.indexOf('Release'))
    expect(html.indexOf('MJD')).toBeGreaterThan(more)
    expect(html).toContain('href="https://irsa.example/obs-1"')
    expect(html).toContain('Level-2 file (AWS S3)')
  })

  it('names a combined observation with its exposures and dates', () => {
    const stack = { ...frame, n_combined: 12, date_end: '2026-05-20T03:00:00Z' }
    const html = renderToStaticMarkup(<FrameDetails frame={stack} index={0} count={3} letter={null} grid={grid} motion={null} />)
    expect(html).toContain('Combined observation: 12 exposures, 2026-05-01 – 2026-05-20')
    expect(html).toContain('→ 2026-05-20 03:00 UTC')
  })

  it('offers Set A / Set B for the shown frame, pressed when it already is one, disabled for the other letter', () => {
    const html = renderToStaticMarkup(<FrameDetails frame={frame} index={1} count={8} letter="B" grid={grid} motion={null}
      pair={{ a: 0, b: 1 }} onSet={() => undefined} />)
    expect(html).toContain('disabled="" aria-pressed="false" title="Use observation 2 as A">Set A</button>')
    expect(html).toContain('aria-pressed="true" title="Use observation 2 as B">Set B</button>')
    expect(renderToStaticMarkup(<FrameDetails frame={frame} index={1} count={8} letter={null} grid={grid} motion={null} />)).not.toContain('Set A')
  })

  it('says when the possible track lies outside this frame', () => {
    const html = renderToStaticMarkup(<FrameDetails frame={frame} index={1} count={8} letter={null} grid={grid} motion={null}
      predictions={[{ mjd: frame.mjd, ra: 10, dec: 21, radius_arcsec: 9 }]} />)
    expect(html).toContain('predicted position outside this frame')
  })
})
