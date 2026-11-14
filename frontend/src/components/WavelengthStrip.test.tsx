import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DETECTORS } from '../targets'
import { DETECTOR_RANGES_UM, WavelengthStrip, detectorText, passband, wavelengthText } from './WavelengthStrip'

describe('WavelengthStrip', () => {
  it('uses the same detector ranges as the detector list', () => {
    for (const { band, label } of DETECTORS) {
      expect(label).toBe(detectorText(band).replace(' ', ' · '))
    }
    expect(Object.keys(DETECTOR_RANGES_UM)).toHaveLength(6)
  })

  it('centres one resolution element on the frame wavelength', () => {
    const [lo, hi] = passband({ wavelength_um: 4.601, bandwidth_um: 0.035 })!
    expect(lo).toBeCloseTo(4.5835)
    expect(hi).toBeCloseTo(4.6185)
    expect(passband({ wavelength_um: null, bandwidth_um: null })).toBeNull()
  })

  it('names the wavelength or says it is unknown', () => {
    expect(wavelengthText({ wavelength_um: 4.601, bandwidth_um: 0.035 })).toBe(
      'λ 4.601 µm, bandwidth 0.035 µm',
    )
    expect(wavelengthText(null)).toBe('wavelength unknown')
  })

  it('outlines the selected detector and marks the frame', () => {
    const html = renderToStaticMarkup(
      <WavelengthStrip detector={6} frame={{ wavelength_um: 4.601, bandwidth_um: 0.035 }} />,
    )
    expect(html.match(/class="viz-band selected"/g)).toHaveLength(1)
    expect(html).toContain('▼ 4.601 µm')
    expect(html).toContain('selected D6 4.41–5.01 µm')
  })

  it('shows no marker without a wavelength', () => {
    const html = renderToStaticMarkup(<WavelengthStrip detector={2} />)
    expect(html).not.toContain('viz-marker')
    expect(html).toContain('Current frame: wavelength unknown.')
  })
})
