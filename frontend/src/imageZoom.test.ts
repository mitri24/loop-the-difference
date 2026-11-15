import { describe, expect, it } from 'vitest'
import { FIT, MAX_ZOOM, clampView, panBy, viewTransform, zoomAt, zoomText } from './imageZoom'

// Where an image point (u, v) lands in the viewport, as fractions: the inverse of the view.
const screenOf = (view: { z: number; cx: number; cy: number }, u: number, v: number) => ({
  x: 0.5 + (u - view.cx) * view.z,
  y: 0.5 + (v - view.cy) * view.z,
})

describe('image zoom', () => {
  it('keeps the image point under the pointer while zooming in and out', () => {
    const view = zoomAt(FIT, 2, 0.8, 0.3)
    expect(view.z).toBe(2)
    // Image point under (0.8, 0.3) at 1×: (0.8, 0.3); at 2× it is still there.
    expect(screenOf(view, 0.8, 0.3).x).toBeCloseTo(0.8, 9)
    expect(screenOf(view, 0.8, 0.3).y).toBeCloseTo(0.3, 9)
    const deeper = zoomAt(view, 1.5, 0.25, 0.75)
    const u = view.cx + (0.25 - 0.5) / view.z
    const v = view.cy + (0.75 - 0.5) / view.z
    expect(screenOf(deeper, u, v).x).toBeCloseTo(0.25, 9)
    expect(screenOf(deeper, u, v).y).toBeCloseTo(0.75, 9)
  })

  it('stays between 1× and the maximum and never shows anything beside the image', () => {
    expect(zoomAt(FIT, 1 / 3)).toEqual(FIT)
    expect(zoomAt(FIT, 100).z).toBe(MAX_ZOOM)
    // Zooming in at a corner: the view centre moves only as far as the image reaches.
    expect(zoomAt(FIT, 4, 0, 0)).toEqual({ z: 4, cx: 0.125, cy: 0.125 })
    expect(clampView({ z: 2, cx: 0.99, cy: 0.01 })).toEqual({ z: 2, cx: 0.75, cy: 0.25 })
    // Zooming back out to 1× centres the image again.
    expect(zoomAt({ z: 2, cx: 0.75, cy: 0.25 }, 0.5)).toEqual(FIT)
  })

  it('drags the image with the pointer and stops at its edges', () => {
    const view = { z: 2, cx: 0.5, cy: 0.5 }
    // Pointer moves right by a tenth of the viewport: the image follows, so the view centre moves left on it.
    expect(panBy(view, 0.1, 0).cx).toBeCloseTo(0.45, 9)
    expect(panBy(view, 0, -0.1).cy).toBeCloseTo(0.55, 9)
    expect(panBy(view, 5, 5)).toEqual({ z: 2, cx: 0.25, cy: 0.25 })
    expect(panBy(FIT, 0.3, 0.3)).toEqual(FIT)
  })

  it('writes a transform that puts the view centre in the middle, and its inverse', () => {
    expect(viewTransform(FIT)).toEqual({ transform: 'translate(0%, 0%) scale(1)', unzoom: 'scale(1) translate(0%, 0%)' })
    // 2× around (0.75, 0.25): the image moves left by 100 % and stays at the top edge.
    expect(viewTransform({ z: 2, cx: 0.75, cy: 0.25 })).toEqual({
      transform: 'translate(-100%, 0%) scale(2)',
      unzoom: 'scale(0.5) translate(100%, 0%)',
    })
  })

  it('names the zoom briefly', () => {
    expect([1, 1.5, 2.25, 8].map(zoomText)).toEqual(['1×', '1.5×', '2.3×', '8×'])
  })
})
