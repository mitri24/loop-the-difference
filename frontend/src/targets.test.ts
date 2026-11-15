import { describe, expect, it } from 'vitest'
import { CHALLENGE_TARGETS, exampleLabel, presetView, targetText } from './targets'
import { POLARIS } from './url'

const preset = (label: string) => CHALLENGE_TARGETS.find((target) => target.label.startsWith(label))!

describe('presetView', () => {
  const draft = { ...POLARIS, band: 4, fov: 0.4 }

  it('opens Pluto on D1 with a 0.2° region at its fixed 2026 position', () => {
    const pluto = preset('Pluto')
    expect(pluto).toMatchObject({ ra: '308.5364', dec: '-22.9153' })
    expect(presetView(pluto, draft)).toMatchObject({ band: 1, fov: 0.2 })
  })

  it('keeps the current detector and region size for the other presets', () => {
    expect(presetView(preset('WISE 0855'), draft)).toMatchObject({ band: 4, fov: 0.4 })
  })
})

describe('targetText', () => {
  it('names a comparison once: by its name, else its example label, else its coordinates', () => {
    expect(targetText({ ...POLARIS, ra: '268.754890', dec: '5.716980', name: '17 55 01.17 +05 43 01.1' })).toBe('17 55 01.17 +05 43 01.1')
    expect(targetText({ ...POLARIS, ra: '308.5364', dec: '-22.9153' })).toBe('Pluto · known dwarf planet (2026)')
    expect(targetText(POLARIS)).toBe('Polaris')
    expect(targetText({ ...POLARIS, ra: '268.754890', dec: '5.716980' })).toBe('268.754890, 5.716980')
  })

  it('finds an example only by its exact preset coordinates', () => {
    expect(exampleLabel({ ra: '08h55m10.831s', dec: '-7d14m42.53s' })).toBe('WISE 0855')
    expect(exampleLabel({ ra: '308.5365', dec: '-22.9153' })).toBeUndefined()
  })
})
