import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../types'
import { BlinkPlayer } from './BlinkPlayer'

const frame = (epoch: number, date: string): Frame => ({
  index: epoch,
  url: `/api/frames/job/frame_${epoch}.png`,
  obs_id: `obs-${epoch}`,
  date,
  mjd: 0,
  detector: 3,
  wavelength_min_um: 1.6,
  wavelength_max_um: 1.7,
  coverage: 1,
  source_url: `https://irsa.example/obs-${epoch}`,
  epoch,
  n_combined: 1,
  date_end: null,
  masked_fraction: null,
  wavelength_um: 1.65,
  bandwidth_um: 0.04,
})
const grid = { ra: 10, dec: 20, size_deg: 0.05, pixel_scale_arcsec: 6.15, collection: 'spherex_dr1' }

describe('BlinkPlayer', () => {
  it('opens in Blink A↔B with the pair as the image header: A, Swap, B', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} />)
    expect(html).toContain('aria-pressed="true" aria-label="Blink A↔B"')
    expect(html).toContain('A · 2025-11-10 07:08 UTC')
    // Header order: A, Swap, B – and before the image.
    const head = html.indexOf('class="pair-head"')
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(html.indexOf('class="viewport"'))
    expect(html.indexOf('Show frame A')).toBeLessThan(html.indexOf('Swap A and B'))
    expect(html.indexOf('Swap A and B')).toBeLessThan(html.indexOf('Show frame B'))
    // B is named by its date (grouped by epoch) and wavelength; the rest of a frame's story is in the Frame tab.
    expect(html).toContain('<optgroup label="Epoch 2"><option value="1" selected="">2026-05-01 10:00 UTC</option></optgroup>')
    expect(html).toContain('<span class="pair-detail">λ 1.65 ± 0.02 µm</span>')
    expect(html).not.toContain('player-side')
    expect(html).not.toMatch(/Before|After/)
  })

  it('names each release in the pair only when A and B differ', () => {
    const same = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')].map((f) => ({ ...f, release: 'DR1' }))
    expect(renderToStaticMarkup(<BlinkPlayer frames={same} grid={grid} motion={null} />)).not.toContain('µm · DR1')
    const mixed = [{ ...same[0] }, { ...same[1], release: 'QR3' }]
    const html = renderToStaticMarkup(<BlinkPlayer frames={mixed} grid={grid} motion={null} />)
    expect(html).toContain('λ 1.65 ± 0.02 µm · DR1</span>')
    expect(html).toContain('λ 1.65 ± 0.02 µm · QR3</span>')
  })

  it('keeps one frame in the plain player with Play disabled and no pair', () => {
    const html = renderToStaticMarkup(<BlinkPlayer frames={[frame(0, '2025-11-10T07:08:30Z')]} grid={grid} motion={null} />)
    expect(html).not.toContain('Blink A↔B')
    expect(html).not.toContain('pair-head')
    expect(html).toContain('disabled="">Play')
    expect(html).toContain('>2025-11-10 07:08 UTC<')
  })

  it('draws the possible-track search area on the cutout only when it lies inside', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z')]
    const inside = renderToStaticMarkup(
      <BlinkPlayer frames={frames} grid={grid} motion={null} predictions={[{ mjd: 0, ra: 10, dec: 20, radius_arcsec: 9 }]} />,
    )
    expect(inside).toContain('class="search-area"')
    expect(inside).toContain('left:50%;top:50%;width:10%')
    const outside = renderToStaticMarkup(
      <BlinkPlayer frames={frames} grid={grid} motion={null} predictions={[{ mjd: 0, ra: 10, dec: 21, radius_arcsec: 9 }]} />,
    )
    expect(outside).not.toContain('search-area')
  })
})
