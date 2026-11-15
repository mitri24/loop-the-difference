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
  it('opens in Blink A↔B with the pair A and B beside the image', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} />)
    expect(html).toContain('aria-pressed="true" aria-label="Blink A↔B"')
    expect(html).toContain('A · 2025-11-10 07:08 UTC')
    expect(html).toContain('Show frame A')
    expect(html).toContain('Show frame B')
    // B is named by its date and wavelength in the pair, the shown frame A by its full provenance.
    expect(html).toContain('<optgroup label="Epoch 2"><option value="1" selected="">2026-05-01 10:00 UTC</option></optgroup>')
    expect(html).toContain('<span class="pair-detail">epoch 2 · λ 1.65 ± 0.02 µm</span>')
    expect(html).toContain('SPHEREx DR1 (spherex_dr1)')
    expect(html).toContain('D3 · λ 1.65 ± 0.02 µm')
    expect(html).toContain('href="https://irsa.example/obs-0"')
    expect(html).not.toMatch(/Before|After/)
  })

  it('names each release in the pair only when A and B differ', () => {
    const same = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')].map((f) => ({ ...f, release: 'DR1' }))
    expect(renderToStaticMarkup(<BlinkPlayer frames={same} grid={grid} motion={null} />)).not.toContain('µm · SPHEREx')
    const mixed = [{ ...same[0] }, { ...same[1], release: 'QR3' }]
    const html = renderToStaticMarkup(<BlinkPlayer frames={mixed} grid={grid} motion={null} />)
    expect(html).toContain('λ 1.65 ± 0.02 µm · SPHEREx DR1')
    expect(html).toContain('λ 1.65 ± 0.02 µm · SPHEREx QR3')
  })

  it('keeps one frame in the plain player with Play disabled', () => {
    const html = renderToStaticMarkup(<BlinkPlayer frames={[frame(0, '2025-11-10T07:08:30Z')]} grid={grid} motion={null} />)
    expect(html).not.toContain('Blink A↔B')
    expect(html).toContain('disabled="">Play')
    expect(html).toContain('>2025-11-10 07:08 UTC<')
  })

  it('draws the possible-track search area on the cutout or says it is outside the frame', () => {
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
    expect(outside).toContain('predicted position outside this frame')
  })
})
