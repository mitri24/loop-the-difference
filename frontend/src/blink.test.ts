import { describe, expect, it } from 'vitest'
import { compatiblePair, defaultBlinkPair, frameRelease, lambdaText, letterOf, nextIndex, releaseLabel, stampText } from './blink'
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

  it('opens with a compatible pair: same wavelength, different epochs, the longest baseline, the earlier one as A', () => {
    const at = (epoch: number, mjd: number, wavelength_um: number | null) => ({ ...frame(epoch), mjd, wavelength_um })
    // D3 resolves λ/Δλ = 41: 1.65 and 1.70 µm are two wavelengths, 1.65 and 1.66 µm one.
    const frames = [at(0, 0, 1.65), at(0, 1, 1.7), at(1, 180, 1.7), at(2, 360, 1.66), at(2, 361, 1.8)]
    expect(compatiblePair(frames)).toEqual({ a: 0, b: 3 })
    expect(defaultBlinkPair(frames)).toEqual({ a: 0, b: 3 })
    // The earlier frame is A whatever the order of the list.
    expect(compatiblePair([at(2, 360, 1.65), at(0, 0, 1.65)])).toEqual({ a: 1, b: 0 })
    // Equal baselines: the epochs further apart.
    expect(compatiblePair([at(0, 0, 1.65), at(1, 0, 1.65), at(2, 0, 1.65)])).toEqual({ a: 0, b: 2 })
  })

  it('has no compatible pair within one epoch, across wavelengths or with unknown wavelengths', () => {
    expect(compatiblePair([0, 0].map((e) => ({ ...frame(e), wavelength_um: 1.65 })))).toBeNull()
    expect(compatiblePair([{ ...frame(0), wavelength_um: 1.65 }, { ...frame(1), wavelength_um: 1.75 }])).toBeNull()
    expect(compatiblePair([frame(0), frame(1)])).toBeNull()
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
    // A search over several releases lists them instead of the raw comma-joined collection names.
    expect(releaseLabel('spherex_dr1,spherex_dr1_deep,spherex_qr3,spherex_qr3_deep')).toBe('SPHEREx DR1 · DR1 deep · QR3 · QR3 deep')
    expect(releaseLabel('spherex_dr1,TEST')).toBe('spherex_dr1,TEST')
    expect(frameRelease({ release: 'QR3' }, 'spherex_dr1,spherex_qr3')).toBe('SPHEREx QR3')
    expect(frameRelease({}, 'spherex_dr1')).toBe('SPHEREx DR1 (spherex_dr1)')
  })
})
