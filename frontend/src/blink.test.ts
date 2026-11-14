import { describe, expect, it } from 'vitest'
import { defaultBlinkPair, lambdaText, letterOf, nextIndex, releaseLabel, stampText } from './blink'
import type { Frame } from './types'

const frame = (epoch: number, date = '2026-03-10T12:00:00Z'): Frame => ({
  index: 0,
  url: `/f/${epoch}.png`,
  obs_id: 'obs',
  date,
  mjd: 0,
  detector: 3,
  wavelength_min_um: 1.6,
  wavelength_max_um: 1.7,
  coverage: 1,
  source_url: 'https://irsa.example/obs',
  epoch,
  n_combined: 1,
  date_end: null,
  masked_fraction: null,
  wavelength_um: null,
  bandwidth_um: null,
})

describe('blink helpers', () => {
  it('pairs the first frame of the earliest and of the latest epoch', () => {
    expect(defaultBlinkPair([0, 0, 1, 1, 2].map((e) => frame(e)))).toEqual({ a: 0, b: 4 })
    expect(defaultBlinkPair([0, 0, 1, 1, 2, 2].map((e) => frame(e)))).toEqual({ a: 0, b: 4 })
  })

  it('uses the last frame as B with one epoch and no pair with one frame', () => {
    expect(defaultBlinkPair([0, 0, 0].map((e) => frame(e)))).toEqual({ a: 0, b: 2 })
    expect(defaultBlinkPair([frame(0)])).toBeNull()
  })

  it('alternates A and B, or loops without a pair', () => {
    const pair = { a: 1, b: 3 }
    expect(nextIndex(1, 5, pair)).toBe(3)
    expect(nextIndex(3, 5, pair, -1)).toBe(1)
    expect(nextIndex(4, 5, pair)).toBe(1)
    expect(nextIndex(4, 5, null)).toBe(0)
    expect(nextIndex(0, 5, null, -1)).toBe(4)
    expect(letterOf(3, pair)).toBe('B')
    expect(letterOf(2, pair)).toBeNull()
  })

  it('labels frames in UTC with letter, wavelength and release', () => {
    expect(stampText(frame(0), 'A')).toBe('A · 2026-03-10 12:00 UTC')
    expect(stampText(frame(0), null)).toBe('2026-03-10 12:00 UTC')
    expect(lambdaText(frame(0))).toBe('λ 1.60–1.70 µm')
    expect(lambdaText({ ...frame(0), wavelength_um: 1.652, bandwidth_um: 0.04 })).toBe('λ 1.65 ± 0.02 µm')
    expect(releaseLabel('spherex_dr1')).toBe('SPHEREx DR1 (spherex_dr1)')
    expect(releaseLabel('TEST_FIXTURE')).toBe('TEST_FIXTURE')
  })
})
