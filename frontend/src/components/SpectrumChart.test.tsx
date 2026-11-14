import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Check, SpectrumPoint } from '../types'
import { Plot, SpectrumChart, epochColour, ranges, scale, summarize } from './SpectrumChart'

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

  it('maps data onto pixels, a flat range to the middle', () => {
    expect(scale([0, 10], [100, 200])(5)).toBe(150)
    expect(scale([0, 10], [200, 100])(10)).toBe(100)
    expect(scale([3, 3], [0, 10])(3)).toBe(5)
  })

  it('gives neighbouring epochs different colours', () => {
    expect(epochColour(0)).not.toBe(epochColour(1))
  })

  it('draws a single point with one tick per axis and links it to its cutout', () => {
    const html = renderToStaticMarkup(<Plot points={[point(0, 2.0, 0, 0)]} />)

    expect(html.match(/<text[^>]*>2\.00<\/text>/g)).toHaveLength(1)
    expect(html).toContain('href="https://irsa.example/cutout"')
  })

  it('starts on request and says it is a quick-look spectrum', () => {
    const html = renderToStaticMarkup(<SpectrumChart ra="76.956" dec="30.401" />)

    expect(html).toContain('Quick-look spectrum')
    expect(html).toContain('Build quick-look spectrum')
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
  })

  it('draws the same exposure on two detectors as two points', () => {
    const twice = [point(0, 2.0, 5, 1), { ...point(0, 2.0, 5, 1), detector: 6, wavelength_um: 4.4 }]

    expect(renderToStaticMarkup(<Plot points={twice} />).match(/<circle/g)).toHaveLength(2)
  })
})
