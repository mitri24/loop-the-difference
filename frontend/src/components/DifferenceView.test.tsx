import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PairChanges } from '../pairDifference'
import type { Frame, FrameManifest, PairDifference, Residual } from '../types'
import { DifferenceView, epochLabel } from './DifferenceView'

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

const manifest: FrameManifest = {
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
  differences: [],
}

const residual = (significance: number, kind: Residual['kind'], known: string | null = null): Residual => ({
  x: 10, y: 20 + significance, ra: 1.5, dec: 2.25, significance, kind, known, explanation: `Explained ${kind}.`,
})

const result = (extra: Partial<PairDifference> = {}): PairDifference => ({
  job_id: 'job', a: 0, b: 2, comparable: true, reason: null, method: 'zogy',
  significance_url: '/api/frames/job/pairsig_00_02_v1.png', difference_url: '/api/frames/job/pairdiff_00_02_v1.png',
  delta_days: 366, delta_lambda_pct: 0.2, small_bodies_checked: false, residuals: [], checks: [
    { code: 'PAIR_METHOD', severity: 'info', message: 'Significance: PSF-matched difference (ZOGY)', detail: 'Zackay et al.', affects: [] },
  ],
  ...extra,
})

const done = (difference: PairDifference): PairChanges => ({ pair: { a: 0, b: 2 }, status: 'done', result: difference, error: null })
const render = (changes: PairChanges) => renderToStaticMarkup(<DifferenceView manifest={manifest} changes={changes} />)

describe('epochLabel', () => {
  it('shows the stack date range', () => {
    expect(epochLabel(manifest.frames[0], 0)).toBe('2025-05-01 – 2025-05-03')
    expect(epochLabel(manifest.frames[1], 1)).toBe('2025-11-01')
    expect(epochLabel(undefined, 4)).toBe('Image 5')
  })
})

describe('DifferenceView', () => {
  it('puts the result first, the significance image with its legend, and the changes and checks folded', () => {
    const html = render(done(result({ residuals: [residual(-6.2, 'asteroid', '(433) Eros'), residual(7.5, 'unknown')] })))

    expect(html.indexOf('2 changes ≥ 5σ between A and B: 1 known asteroid, 1 needs verification'))
      .toBeLessThan(html.indexOf('>Significance (ZOGY)</button>'))
    expect(html).toContain('src="/api/frames/job/pairsig_00_02_v1.png"')
    expect(html).toContain('aria-checked="true" tabindex="0">Significance (ZOGY)</button>')
    for (const word of ['brighter in A', 'no change', 'brighter in B']) expect(html).toContain(word)
    expect(html).toContain('<details class="disclosure"><summary>Changes ≥ 5σ · 2</summary>')
    expect(html).toContain('−6.2σ · brighter in A · known asteroid (433) Eros')
    expect(html).toContain('<summary>How the changes were found</summary>')
    expect(html).toContain('Significance: PSF-matched difference (ZOGY)')
    expect(html).not.toContain('<details class="disclosure" open')
    // Provenance of both frames.
    expect(html).toContain('obs-0')
    expect(html).toContain('2026-05-02 – 2026-05-04')
  })

  it('says so when nothing changed', () => {
    const html = render(done(result()))

    expect(html).toContain('No change ≥ 5σ between A and B')
    expect(html).not.toContain('Changes ≥ 5σ ·')
  })

  it('shows a pair that does not compare with its reason and no image, unless asked for inspection', () => {
    const html = render(done(result({ comparable: false, reason: 'A and B were observed at different wavelengths (Δλ 2.2 %)' })))

    expect(html).toContain('Not comparable: A and B were observed at different wavelengths (Δλ 2.2 %)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('brighter in A')
    expect(html).toContain('Show the images for inspection only')
  })

  it('names the direct method in the switch and waits with a placeholder while it looks', () => {
    expect(render(done(result({ method: 'direct' })))).toContain('>Significance (direct)</button>')
    const loading = render({ pair: { a: 0, b: 2 }, status: 'loading', result: null, error: null })
    expect(loading).toContain('Finding changes between A and B…')
    expect(loading).not.toContain('<img')
  })
})
