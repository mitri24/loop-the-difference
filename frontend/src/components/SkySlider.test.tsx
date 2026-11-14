import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkySlider } from './SkySlider'

describe('SkySlider', () => {
  it('names the channel, its detector and the blank dichroic channels', () => {
    const html = renderToStaticMarkup(<SkySlider value={42} onChange={() => undefined} />)
    expect(html).toContain('type="range"')
    expect(html).toContain('max="101"')
    expect(html).toContain('aria-valuetext="Channel 43 of 102 · D3 · wavelength unknown"')
    expect(html).toContain('Reading channel wavelengths from IRSA')
    expect(html).toContain('channels 51–52 are blank (dichroic gap)')
    expect(html).not.toContain('disabled')
  })

  it('is disabled with a reason while another survey is the background', () => {
    const html = renderToStaticMarkup(
      <SkySlider value={8} onChange={() => undefined} active={false} />,
    )
    expect(html).toContain('disabled')
    expect(html).toContain('The background is not the SPHEREx DR1 cube')
  })
})
