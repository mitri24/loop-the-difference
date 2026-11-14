import { describe, expect, it } from 'vitest'
import { CHALLENGE_TARGETS, presetView } from './targets'
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
