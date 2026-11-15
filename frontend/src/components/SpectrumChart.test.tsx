import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Check, SpectrumPoint } from '../types'
import {
  Plot,
  SpectrumChart,
  bandColour,
  epochShape,
  fluxTick,
  offScale,
  ranges,
  scale,
  summarize,
} from './SpectrumChart'

const point = (epoch: number, wavelength: number, flux: number, err: number): SpectrumPoint => ({
  obs_id: `obs-${epoch}-${wavelength}`,
  date: '2025-05-01T00:00:00',
  mjd: 60796,
  detector: 4,
  epoch,
  wavelength_um: wavelength,
  bandwidth_um: 0.1,
  flux_ujy: flux,
  flux_err_ujy: err,
  source_url: 'https://irsa.example/cutout',
})

describe('SpectrumChart', () => {
  it('fits every error bar and the zero line into the axes', () => {
    const r = ranges([point(0, 1.0, 50, 5), point(1, 4.5, -10, 20)])

    expect(r.x).toEqual([1.0, 4.5])
    expect(r.y).toEqual([-30, 55])
  })

  it('keeps a flagged outlier from setting the flux axis', () => {
    const r = ranges([point(0, 1.0, 50, 5), { ...point(0, 2.0, 125000, 10), flagged: true }])

    expect(r.x).toEqual([1.0, 2.0])
    expect(r.y).toEqual([0, 55])
  })

  it('maps data onto pixels, a flat range to the middle', () => {
    expect(scale([0, 10], [100, 200])(5)).toBe(150)
    expect(scale([0, 10], [200, 100])(10)).toBe(100)
    expect(scale([3, 3], [0, 10])(3)).toBe(5)
  })

  it('colours points by detector band and tells epochs apart by marker shape', () => {
    expect(bandColour(4)).toBe('var(--band-d4)')
    expect(epochShape(0)).not.toBe(epochShape(1))
    const html = renderToStaticMarkup(
      <Plot points={[point(0, 2.0, 5, 1), { ...point(1, 2.1, 6, 1), detector: 3 }]} />,
    )

    // Marks only (legend swatches and hover targets have their own classes): epoch 1 a circle, epoch 2 a square.
    expect(html.match(/<circle class="viz-mark"/g)).toHaveLength(1)
    expect(html.match(/<rect class="viz-mark"/g)).toHaveLength(1)
    expect(html).toContain('fill="var(--band-d3)"')
    expect(html).toContain('D3</li>')
    expect(html).toContain('Epoch 2 (')
  })

  it('draws a single point with one tick per axis and links it to its cutout', () => {
    const html = renderToStaticMarkup(<Plot points={[point(0, 2.0, 0, 0)]} />)

    expect(html.match(/<text[^>]*>2\.00<\/text>/g)).toHaveLength(1)
    expect(html).toContain('href="https://irsa.example/cutout"')
  })

  it('measures on request, one measurement for brightness over time and the spectrum', () => {
    const quick = { job: null, error: null, running: false, spectrum: null, start: () => undefined }
    const html = renderToStaticMarkup(<SpectrumChart quick={quick} centerUm={1.65} detector={3} />)
    expect(html).toContain('aria-label="Quick-look photometry"')
    expect(html).toContain('Measure the target in all SPHEREx visits')
  })

  it('shows brightness over time before the spectrum, with the quick-look caveat', () => {
    const points = [point(0, 1.65, 10, 1), point(1, 1.66, 12, 1), point(2, 2.4, 9, 1)]
    const spectrum = { collection: 'spherex_dr1', ra: 1, dec: 2, complete: true, points, checks: [] }
    const quick = { job: { job_id: 's', status: 'finished' as const, progress: 3, total: 3, error: null, spectrum },
      error: null, running: false, spectrum, start: () => undefined }
    const html = renderToStaticMarkup(<SpectrumChart quick={quick} centerUm={1.65} detector={3} />)
    expect(html.indexOf('Brightness at the target over time')).toBeGreaterThan(-1)
    expect(html.indexOf('Brightness at the target over time')).toBeLessThan(html.indexOf('Flux at the target by wavelength'))
    expect(html).toContain('Quick-look only')
    expect(html).not.toContain('Measure the target in all SPHEREx visits')
  })

  it('counts missing cutouts for the retry and keeps the other notes', () => {
    const check = (code: string, detail: string): Check => ({
      code,
      severity: 'info',
      message: code,
      detail,
      affects: [],
    })
    const missing = check('CUTOUT_MISSING', 'obs-1: not delivered')

    expect(summarize([missing, check('QUICK_LOOK_SPECTRUM', 'not calibrated')])).toEqual({
      retry: 'Retry the 1 visit the archive did not deliver',
      notes: ['not calibrated'],
    })
    expect(summarize([missing, missing]).retry).toContain('2 visits')
    expect(summarize([check('SPECTRUM_GAIA_UNAVAILABLE', 'no Gaia')]).retry).toBe(
      'Build the spectrum again',
    )
  })

  it('draws the same exposure on two detectors as two points', () => {
    const twice = [point(0, 2.0, 5, 1), { ...point(0, 2.0, 5, 1), detector: 6, wavelength_um: 4.4 }]

    expect(renderToStaticMarkup(<Plot points={twice} />).match(/<circle class="viz-mark"/g)).toHaveLength(2)
  })

  it('draws a point with flagged aperture pixels hollow and says so', () => {
    const html = renderToStaticMarkup(
      <Plot points={[point(0, 2.0, 5, 1), { ...point(0, 3.0, 5, 1), flagged: true }]} />,
    )

    // Hollow = the chart surface inside, the band colour as outline.
    expect(html.match(/class="viz-mark"[^>]*fill="var\(--surface-1\)"/g)).toHaveLength(1)
    expect(html).toContain('flagged pixels in aperture, flux unreliable')
    expect(html).toContain('flagged pixels in aperture</li>')
  })

  it('draws a point beyond the flux axis as an arrow on the edge and explains it', () => {
    const saturated = { ...point(0, 3.0, 125000, 10), flagged: true }
    const html = renderToStaticMarkup(<Plot points={[point(0, 2.0, 5, 1), saturated]} />)

    expect(html.match(/<circle class="viz-mark"/g)).toHaveLength(1)
    expect(html.match(/<path class="viz-mark" d="M[^"]+"[^>]*fill="var\(--surface-1\)"/g)).toHaveLength(1)
    expect(html).toContain('125000.0 ± 10.0 µJy')
    expect(html).toContain('beyond the flux axis · open the cutout')
    expect(html).toContain('beyond the flux axis (value in the tooltip)')
  })

  it('tells above from below the axes', () => {
    expect([offScale(0), offScale(100), offScale(1000)]).toEqual(['above', null, 'below'])
  })

  it('writes seven-digit flux ticks compactly and keeps small ones exact', () => {
    expect([fluxTick(3_600_000, 0), fluxTick(125_000, 0), fluxTick(9_999, 0), fluxTick(2.25, 1)]).toEqual(
      ['3.6M', '125K', '9999', '2.3'],
    )
  })

  it('shows no arrow legend when every point fits', () => {
    expect(renderToStaticMarkup(<Plot points={[point(0, 2.0, 5, 1)]} />)).not.toContain('beyond the flux axis')
  })
})
