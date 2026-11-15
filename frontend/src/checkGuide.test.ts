import { describe, expect, it } from 'vitest'
import { blockedReason, explainChecks, passedChecks } from './checkGuide'
import type { Check, Frame, FrameManifest } from './types'

const check = (code: string, severity: Check['severity'], detail = '', affects: string[] = []): Check =>
  ({ code, severity, message: `${code} message`, detail, affects })
const frame = (index: number, wavelength_um: number | null = 4.7) =>
  ({ index, obs_id: `obs${index}`, wavelength_um } as Frame)
const manifest = (over: Partial<FrameManifest> = {}) =>
  ({ preview: false, epochs: 2, release: 'DR1', frames: [frame(0), frame(1)], ...over })

describe('explainChecks', () => {
  it('says what was checked, why it matters and what to do, grouped from blocking to notes', () => {
    const groups = explainChecks([
      check('SOURCES', 'info', '12 detections'),
      check('CUTOUT_MISSING', 'warning', 'obs1: archive did not deliver'),
      check('WAVELENGTH_MISMATCH', 'blocker', '4.41 to 4.51 µm (2.1 %)', ['difference']),
      check('MIXED_RELEASES', 'info'),
    ])
    expect(groups.map((group) => group.kind)).toEqual(['blocking', 'fixable', 'limit', 'info'])
    const [mismatch] = groups[0].items
    expect(mismatch.title).toBe('Different wavelengths')
    expect(mismatch.text).toContain('cannot be directly subtracted')
    expect(mismatch.text).toContain('Choose a compatible observation')
    expect(mismatch.action).toEqual({ id: 'choose-compatible-pair', label: 'Choose a compatible pair' })
    expect(mismatch.details).toEqual(['4.41 to 4.51 µm (2.1 %)'])
    expect(groups[1].items[0].action?.id).toBe('retry')
  })

  it('makes one entry of the same check on several frames, keeping each detail', () => {
    const [group] = explainChecks([
      check('FLAGGED_PIXELS', 'warning', 'obs1: flagged'),
      check('FLAGGED_PIXELS', 'warning', 'obs2: flagged'),
      check('FLAGGED_PIXELS', 'warning', 'obs3: flagged'),
    ])
    expect(group.items).toHaveLength(1)
    expect(group.items[0].title).toBe('Flagged pixels at the target in 3 images')
    expect(group.items[0].details).toEqual(['obs1: flagged', 'obs2: flagged', 'obs3: flagged'])
    expect(explainChecks([check('CUTOUT_MISSING', 'warning')])[0].items[0].title).toBe('One image not delivered')
  })

  it('asks to wait or retry before leaving a region while images are loading or missing', () => {
    const [loading] = explainChecks([check('SINGLE_EPOCH', 'blocker', '', ['difference']), check('PREVIEW', 'blocker', '', ['difference'])])
    expect(loading.kind).toBe('fixable')
    expect(loading.items[0]).toMatchObject({ title: 'Insufficient observations so far', severity: 'warning', action: undefined })
    expect(explainChecks([check('WAVELENGTH_MISMATCH', 'blocker'), check('PREVIEW', 'blocker')])[0].items[0])
      .toMatchObject({ title: 'Different wavelengths so far', action: undefined })
    expect(loading.items[0].text).toContain('Wait until loading finishes')
    const [missing] = explainChecks([check('NO_OBSERVATIONS', 'error'), check('CUTOUT_MISSING', 'warning')])
    expect(missing.items.map((item) => item.action?.id)).toEqual(['retry', 'retry'])
    expect(explainChecks([check('SOURCES_CATALOG_UNAVAILABLE', 'info')])[0]).toMatchObject({ kind: 'limit', items: [{ action: undefined }] })
    expect(explainChecks([check('WAVELENGTH_CLOSE', 'warning')])[0]).toMatchObject({ kind: 'limit', items: [{ title: 'Slightly different wavelengths' }] })
  })

  it('keeps an unknown check in the backend’s own words, by its severity', () => {
    const [group] = explainChecks([{ code: 'NEW_CHECK', severity: 'warning', message: 'Something new', detail: 'Why it matters', affects: [] }])
    expect(group.kind).toBe('fixable')
    expect(group.items[0]).toMatchObject({ title: 'Something new', text: 'Why it matters', details: [] })
  })
})

describe('blockedReason', () => {
  it('names what a disabled feature needs, from the check that blocks it', () => {
    expect(blockedReason([check('SINGLE_EPOCH', 'blocker', '', ['difference'])], 'difference')?.text)
      .toBe('Difference needs two compatible observations; only one is available here. Select another region or detector.')
    expect(blockedReason([check('WAVELENGTH_MISMATCH', 'blocker', '', ['difference'])], 'difference')?.action?.id)
      .toBe('choose-compatible-pair')
    expect(blockedReason([check('FLAGGED_PIXELS', 'warning', '', ['obs:obs1'])], 'difference')).toBeNull()
    expect(blockedReason([check('SINGLE_EPOCH', 'blocker', '', ['difference']), check('PREVIEW', 'blocker', '', ['difference'])], 'difference')?.text)
      .toBe('Difference is available once the final images are ready.')
  })
})

describe('passedChecks', () => {
  it('lists the checks that ran and found nothing', () => {
    const passed = passedChecks(manifest(), [check('SOURCES', 'info')])
    expect(passed.map((p) => p.code)).toEqual(['ALIGNED', 'EPOCHS', 'WAVELENGTH', 'CUTOUTS', 'FLAGS', 'RELEASES'])
    expect(passed[0]).toMatchObject({ title: 'Images aligned', text: 'Both observations cover a compatible sky coordinate grid.' })
    expect(passed[5].text).toContain('SPHEREx DR1')
  })

  it('never claims a check that failed or could not run', () => {
    const codes = (checks: Check[], over: Partial<FrameManifest> = {}) => passedChecks(manifest(over), checks).map((p) => p.code)
    expect(codes([check('WAVELENGTH_MISMATCH', 'blocker'), check('FLAGGED_PIXELS', 'warning')])).toEqual(['ALIGNED', 'EPOCHS', 'CUTOUTS', 'RELEASES'])
    expect(codes([], { frames: [frame(0), frame(1, null)] })).not.toContain('WAVELENGTH')
    expect(codes([check('WAVELENGTH_UNKNOWN', 'info')])).not.toContain('WAVELENGTH')
    expect(codes([check('WAVELENGTH_CLOSE', 'warning')])).not.toContain('WAVELENGTH')
    expect(codes([check('SINGLE_EPOCH', 'blocker')], { epochs: 1, frames: [frame(0)] })).toEqual(['CUTOUTS', 'FLAGS', 'RELEASES'])
    expect(passedChecks(manifest({ preview: true }), [])).toEqual([])
    expect(passedChecks(manifest({ frames: [] }), [])).toEqual([])
  })
})


it('keeps the injection measurement details under technical details', () => {
  const [group] = explainChecks([check('DETECTION_LIMIT', 'info', '200 stars in ten flux steps')])
  expect(group.items[0].text).toContain('Artificial stars')
  expect(group.items[0].text).not.toContain('ten flux steps')
  expect(group.items[0].details).toEqual(['200 stars in ten flux steps'])
})
