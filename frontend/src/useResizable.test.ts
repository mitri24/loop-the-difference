import { describe, expect, it } from 'vitest'
import { clampSize, keyDelta, storageKey, viewportClass } from './useResizable'

describe('useResizable helpers', () => {
  it('names the viewport class at the shell breakpoints', () => {
    expect(viewportClass(320)).toBe('phone')
    expect(viewportClass(700)).toBe('phone')
    expect(viewportClass(701)).toBe('tablet')
    expect(viewportClass(1023)).toBe('tablet')
    expect(viewportClass(1024)).toBe('desktop')
  })
  it('keeps sizes inside min and max, and min wins when the window is too small', () => {
    expect(clampSize(200, 320, 960)).toBe(320)
    expect(clampSize(2000, 320, 960)).toBe(960)
    expect(clampSize(500.4, 320, 960)).toBe(500)
    expect(clampSize(500, 320, 192)).toBe(320)
  })
  it('moves a leading-edge handle by 16 px: left or up makes the element larger', () => {
    expect(keyDelta('ArrowLeft', 'x', -1)).toBe(16)
    expect(keyDelta('ArrowRight', 'x', -1)).toBe(-16)
    expect(keyDelta('ArrowUp', 'y', -1)).toBe(16)
    expect(keyDelta('ArrowDown', 'y', -1)).toBe(-16)
    expect(keyDelta('ArrowUp', 'x', -1)).toBe(0)
    expect(keyDelta('Enter', 'y', -1)).toBe(0)
  })
  it('stores one size per element and viewport class', () => {
    expect(storageKey('panel-width', 'desktop')).not.toBe(storageKey('panel-width', 'tablet'))
  })
})
