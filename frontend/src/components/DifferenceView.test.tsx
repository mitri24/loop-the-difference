import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Difference, Frame, FrameManifest } from '../types'
import { DifferenceView, blockerText, defaultPair, epochLabel } from './DifferenceView'

const frame = (epoch: number, date: string, dateEnd: string | null): Frame => ({
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
  n_combined: 4,
  date_end: dateEnd,
  masked_fraction: null,
  wavelength_um: null,
  bandwidth_um: null,
})

const diff = (a: number, b: number, comparable: boolean, pct: number | null = 0.4): Difference => ({
  a,
  b,
  url: `/api/frames/job/diff_0${a}_0${b}.png`,
  comparable,
  delta_lambda_pct: pct,
})

const manifest = (differences: Difference[]): FrameManifest => ({
  collection: 'spherex_dr1',
  ra: 0,
  dec: 0,
  size_deg: 0.1,
  detector: 3,
  pixel_scale_arcsec: 6.2,
  epochs: 3,
  complete: true,
  stacked: true,
  frames: [
    frame(0, '2025-05-01T00:00:00Z', '2025-05-03T00:00:00Z'),
    frame(1, '2025-11-01T00:00:00Z', null),
    frame(2, '2026-05-02T00:00:00Z', '2026-05-04T00:00:00Z'),
  ],
  warnings: [],
  checks: [],
  differences,
})

describe('defaultPair', () => {
  it('takes the first epoch with the last comparable epoch', () => {
    const list = [diff(1, 2, true), diff(0, 1, true), diff(0, 2, false), diff(0, 1, true)]
    expect(defaultPair(list)).toMatchObject({ a: 0, b: 1 })
    expect(defaultPair([diff(0, 1, true), diff(0, 2, true)])).toMatchObject({ a: 0, b: 2 })
  })

  it('falls back to first and last epoch when nothing is comparable', () => {
    expect(defaultPair([diff(0, 1, false), diff(0, 2, false)])).toMatchObject({ a: 0, b: 2 })
    expect(defaultPair([])).toBeUndefined()
  })
})

describe('blockerText and epochLabel', () => {
  it('names the wavelength difference in percent', () => {
    expect(blockerText(diff(0, 1, true))).toBeNull()
    expect(blockerText(diff(0, 1, false, 3.456))).toBe(
      'Cannot compare: wavelengths differ by 3.5 %',
    )
    expect(blockerText(diff(0, 1, false, null))).toBe('Cannot compare: wavelengths differ')
  })

  it('shows the stack date range', () => {
    const m = manifest([])
    expect(epochLabel(m.frames[0], 0)).toBe('2025-05-01 – 2025-05-03')
    expect(epochLabel(m.frames[1], 1)).toBe('2025-11-01')
    expect(epochLabel(undefined, 4)).toBe('Epoch 5')
  })
})

describe('DifferenceView', () => {
  it('shows image, legend and provenance for a comparable pair', () => {
    const html = renderToStaticMarkup(
      <DifferenceView manifest={manifest([diff(0, 1, true), diff(0, 2, true)])} />,
    )
    expect(html).toContain('src="/api/frames/job/diff_00_02.png"')
    expect(html).toContain('class="reticle"')
    for (const word of ['brighter earlier', 'no change', 'brighter later', 'needs verification'])
      expect(html).toContain(word)
    expect(html).toContain('obs-0')
    expect(html).toContain('obs-2')
    expect(html).toContain('2026-05-02 – 2026-05-04')
    expect(html).not.toContain('Cannot compare')
  })

  it('hides the image and shows the blocker when not comparable', () => {
    const html = renderToStaticMarkup(
      <DifferenceView manifest={manifest([diff(0, 2, false, 12.34)])} />,
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('brighter earlier')
    expect(html).toContain('Blocker')
    expect(html).toContain('Cannot compare: wavelengths differ by 12.3 %')
    expect(html).toContain('obs-0')
    expect(html).toContain('obs-2')
  })
})
