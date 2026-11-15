import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageMarks } from './ImageMarks'

const grid = { ra: 10, dec: 20, size_deg: 0.2 }

describe('ImageMarks', () => {
  it('puts each marker where it lies on the frame, with its layer symbol and its name on hover', () => {
    const html = renderToStaticMarkup(<ImageMarks grid={grid} marks={[
      { ra: 10, dec: 20, name: 'Gaia DR3 1', kind: 'gaia' },
      { ra: 10, dec: 20.05, name: 'HD 1', kind: 'simbad' },
      { ra: 10, dec: 20, name: 'Detected · S/N 12', kind: 'source-none' },
    ]} />)
    // The centre of the field is the centre of the image; north is up.
    expect(html).toContain('<g class="image-mark gaia" transform="translate(50.00 50.00)"><title>Gaia DR3 1</title><circle r="1.6"></circle></g>')
    expect(html).toMatch(/class="image-mark simbad" transform="translate\(50\.00 2\d\.\d\d\)"/)
    expect(html).toContain('class="image-mark source-none"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('frames a change between A and B in brackets of its own, its σ and class on hover', () => {
    const html = renderToStaticMarkup(<ImageMarks grid={grid} marks={[
      { ra: 10, dec: 20, name: 'Change +7.5σ · brighter in B · needs verification', kind: 'residual' },
    ]} />)

    expect(html).toContain('<g class="image-mark residual" transform="translate(50.00 50.00)"><title>Change +7.5σ · brighter in B · needs verification</title><path d="M-2.4')
  })

  it('leaves out markers outside the image and draws nothing without markers', () => {
    expect(renderToStaticMarkup(<ImageMarks grid={grid} marks={[{ ra: 10, dec: 21, name: 'far', kind: 'wise' }]} />)).toBe('')
    expect(renderToStaticMarkup(<ImageMarks grid={grid} marks={[]} />)).toBe('')
  })
})
