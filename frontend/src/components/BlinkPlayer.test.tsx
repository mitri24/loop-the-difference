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
  it('blinks A and B: the comparison table beside the image, Play for the pair, no separate A↔B / All switch', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} />)
    expect(html).toContain('A · 2025-11-10 07:08 UTC')
    expect(html).toContain('title="Blink A and B"')
    expect(html).not.toContain('Blink A↔B')
    expect(html).not.toContain('Step through all')
    // The table comes after the image: image left, A and B beside it.
    expect(html.indexOf('class="viewport"')).toBeLessThan(html.indexOf('class="pair-table"'))
    expect(html.indexOf('Show frame A')).toBeLessThan(html.indexOf('Show frame B'))
    expect(html).toContain('<optgroup label="Epoch 2 (UTC)"><option value="1" selected="">2026-05-01 10:00</option></optgroup>')
    // "All" at the thumbnails plays every frame.
    expect(html).toContain('title="Play every frame in time order">▶ All</button>')
    expect(html).not.toMatch(/Before|After/)
  })

  it('zooms the image and what stands on it in one layer; the stamp, the checks and the zoom buttons stay outside', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} />)
    const sky = html.slice(html.indexOf('class="viewport-sky"'), html.indexOf('class="stamp"'))
    expect(sky).toContain('<img')
    expect(sky).toContain('class="reticle"')
    expect(html).toContain('transform:translate(0%, 0%) scale(1)')
    expect(html).toContain('--mark-scale:1')
    // At 1× there is nothing to zoom out of or to fit.
    expect(html).toContain('aria-label="Zoom the image"')
    expect(html).toContain('<button type="button" disabled="" aria-label="Zoom out" title="Zoom out (−)">−</button>')
    expect(html).toContain('aria-label="Zoom 1×, fit the whole image"')
    expect(html).toContain('<button type="button" aria-label="Zoom in" title="Zoom in (+)">+</button>')
    expect(html).toContain('plus and minus zoom the image, 0 fits it')
  })

  it('offers Blink and Swipe for a pair, Blink first; a single frame has nothing to swipe', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} />)
    expect(html).toContain('role="radiogroup" aria-label="Compare A and B"')
    expect(html).toContain('<button type="button" role="radio" aria-checked="true">Blink</button>')
    expect(html).toContain('aria-checked="false" title="A left, B right of a line you move, with the same zoom">Swipe</button>')
    expect(html).not.toContain('swipe-line')
    const single = renderToStaticMarkup(<BlinkPlayer frames={[frame(0, '2025-11-10T07:08:30Z')]} grid={grid} motion={null} />)
    expect(single).not.toContain('Compare A and B')
  })

  it('shows what is passed above and below the table', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z')]
    const html = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null}
      controls={<p>images choice</p>} changes={<p>difference image</p>} />)
    expect(html.indexOf('images choice')).toBeLessThan(html.indexOf('class="pair-table"'))
    expect(html.indexOf('difference image')).toBeGreaterThan(html.indexOf('class="pair-table"'))
  })

  it('starts on a shared link\'s A and B when they are given, else on the default pair', () => {
    const frames = [frame(0, '2025-11-10T07:08:30Z'), frame(1, '2026-05-01T10:00:00Z'), frame(2, '2026-11-01T10:00:00Z')]
    const linked = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} initialPair={{ a: 1, b: 2 }} />)
    expect(linked).toContain('A · 2026-05-01 10:00 UTC')
    // An impossible pair falls back to the default.
    const fallback = renderToStaticMarkup(<BlinkPlayer frames={frames} grid={grid} motion={null} initialPair={{ a: 1, b: 1 }} />)
    expect(fallback).toContain('A · 2025-11-10 07:08 UTC')
  })

  it('keeps one frame in the plain player with Play disabled and says there is nothing to blink against', () => {
    const html = renderToStaticMarkup(<BlinkPlayer frames={[frame(0, '2025-11-10T07:08:30Z')]} grid={grid} motion={null} />)
    expect(html).not.toContain('pair-table')
    expect(html).toContain('disabled="" title="Play every frame">Play')
    expect(html).toContain('Only one image here: nothing to blink against.')
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
