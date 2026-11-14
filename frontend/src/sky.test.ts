import { describe, expect, it } from 'vitest'
import { footprintCorners, sliceForDetector, spherexLabel } from './sky'

describe('SPHEREx cube frame per detector', () => {
  it('picks the middle channel of each band, frame = 17 · (band − 1) + 8', () => {
    expect(sliceForDetector(1)).toBe(8)
    expect(sliceForDetector(3)).toBe(42)
    expect(sliceForDetector(6)).toBe(93)
  })

  it('names the wavelength of that frame', () => {
    expect(spherexLabel(6)).toBe('SPHEREx DR1, D6 (~4.7 µm)')
    expect(spherexLabel(1)).toBe('SPHEREx DR1, D1 (~0.9 µm)')
  })
})

describe('frame footprint', () => {
  it('is a square of the frame size around the target on the equator', () => {
    const corners = footprintCorners(10, 0, 0.2)
    expect(corners).toHaveLength(4)
    for (const [ra, dec] of corners!) {
      expect(Math.abs(ra - 10)).toBeCloseTo(0.1, 3)
      expect(Math.abs(dec)).toBeCloseTo(0.1, 3)
    }
    expect(corners![0][1]).toBeGreaterThan(0)
    expect(corners![3][1]).toBeLessThan(0)
  })

  it('stays a polygon of real sky positions on Polaris', () => {
    const corners = footprintCorners(37.954542, 89.264111, 0.2)
    expect(corners).toHaveLength(4)
    for (const [ra, dec] of corners!) {
      expect(ra).toBeGreaterThanOrEqual(0)
      expect(ra).toBeLessThan(360)
      expect(dec).toBeGreaterThan(89.1)
      expect(dec).toBeLessThan(90)
    }
  })

  it('gives up on a square that contains the pole', () => {
    expect(footprintCorners(0, 89.95, 0.2)).toBeNull()
    expect(footprintCorners(0, -89.99, 0.02)).toBeNull()
  })

  it('wraps right ascension at 0/360', () => {
    const corners = footprintCorners(359.95, 0, 0.2)!
    const ras = corners.map(([ra]) => ra)
    expect(Math.min(...ras)).toBeCloseTo(0.05, 3)
    expect(Math.max(...ras)).toBeCloseTo(359.85, 3)
  })
})
