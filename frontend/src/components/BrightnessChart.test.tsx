import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SpectrumPoint } from '../types'
import {
  BrightnessChart,
  R_BY_DETECTOR,
  inWindow,
  niceTicks,
  wavelengthWindow,
} from './BrightnessChart'

const point = (mjd: number, wavelength: number, flux: number, extra: Partial<SpectrumPoint> = {}) => ({
  obs_id: `obs-${mjd}-${wavelength}`,
  date: '2025-05-01T00:00:00',
  mjd,
  detector: 3,
  epoch: 0,
  wavelength_um: wavelength,
  bandwidth_um: 0.05,
  flux_ujy: flux,
  flux_err_ujy: 2,
  source_url: 'https://irsa.example/cutout',
  ...extra,
})

describe('BrightnessChart', () => {
  it('uses the shared resolving power per detector (comparabilityParameters.test.ts keeps it equal to the backend)', () => {
    expect(R_BY_DETECTOR).toEqual({ 1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128 })
  })

  it('takes one resolution element around the centre, R from the given detector or its range', () => {
    const w = wavelengthWindow(2.0, 3)!
    expect(w.lo).toBeCloseTo(2.0 * (1 - 1 / 82))
    expect(w.hi).toBeCloseTo(2.0 * (1 + 1 / 82))
    expect((w.hi - w.lo) / 2.0).toBeCloseTo(1 / 41)
    expect(wavelengthWindow(4.6)!.r).toBe(128)
    expect(wavelengthWindow(7)).toBeNull()
  })

  it('puts flux ticks on round values', () => {
    expect(niceTicks([96.3, 137.9])).toEqual({ values: [100, 110, 120, 130], decimals: 0, step: 10 })
    expect(niceTicks([-0.83, 1.27])).toEqual({ values: [-0.5, 0, 0.5, 1], decimals: 1, step: 0.5 })
  })

  it('keeps the points in the window, oldest first', () => {
    const points = [point(60990, 2.01, 5), point(60796, 1.99, 4), point(60800, 2.3, 9)]
    expect(inWindow(points, wavelengthWindow(2.0, 3)!).map((p) => p.mjd)).toEqual([60796, 60990])
  })

  it('plots flux against date, flagged points hollow, with the window stated', () => {
    const html = renderToStaticMarkup(
      <BrightnessChart
        points={[point(60796, 2.0, 5), point(60990, 2.01, 7, { flagged: true }), point(60800, 3, 1)]}
        centerUm={2.0}
        detector={3}
      />,
    )
    expect(html.match(/class="viz-point"/g)).toHaveLength(1)
    expect(html.match(/class="viz-point flagged"/g)).toHaveLength(1)
    expect(html).toContain('Quick-look aperture photometry, not calibrated, wavelength window 1.976–2.024 µm')
    expect(html).toContain('Date (UTC)')
    expect(html).toContain('href="https://irsa.example/cutout"')
  })

  it('says so when too few visits fall into the window or the wavelength is unknown', () => {
    const one = renderToStaticMarkup(<BrightnessChart points={[point(60796, 2.0, 5)]} centerUm={2.0} />)
    expect(one).toContain('Only one visit measured the target within 1.976–2.024 µm')
    expect(one).not.toContain('<svg')
    expect(renderToStaticMarkup(<BrightnessChart points={[]} />)).toContain(
      'has no known wavelength',
    )
  })
})
