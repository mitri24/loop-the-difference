import { describe, expect, it } from 'vitest'
import { gridWcs, layerNames } from './frameLayers'

const manifest = { ra: 133.795, dec: -7.245, pixel_scale_arcsec: 6.15 }

describe('frame layers on the sky', () => {
  it('matches the backend TAN grid, north up and east left', () => {
    const wcs = gridWcs(manifest, 117, 117)
    expect(wcs).toMatchObject({
      NAXIS: 2,
      NAXIS1: 117,
      NAXIS2: 117,
      CTYPE1: 'RA---TAN',
      CTYPE2: 'DEC--TAN',
      CRVAL1: 133.795,
      CRVAL2: -7.245,
      CRPIX1: 59,
      CRPIX2: 59,
    })
    expect(wcs.CDELT1).toBeCloseTo(-0.0017083333, 9)
    expect(wcs.CDELT2).toBeCloseTo(0.0017083333, 9)
  })

  it('flipNorth flips only CDELT2', () => {
    const plain = gridWcs(manifest, 117, 117)
    const flipped = gridWcs(manifest, 117, 117, true)
    expect(flipped).toEqual({ ...plain, CDELT2: -plain.CDELT2 })
  })

  it('names at most 12 layers', () => {
    expect(layerNames(3)).toEqual(['ltd-frame-00', 'ltd-frame-01', 'ltd-frame-02'])
    expect(layerNames(20)).toHaveLength(12)
    expect(layerNames(12).at(-1)).toBe('ltd-frame-11')
  })
})
