import { describe, expect, it } from 'vitest'
import type { Check, Frame, FrameManifest } from '../types'
import { checksForFrame, frameFlags, groupBySeverity, hasBlocker, manifestChecks } from './EvidencePanel'

const CHECKS: Check[] = [
  {
    code: 'CUTOUT_MISSING',
    severity: 'warning',
    message: 'One cutout could not be downloaded',
    detail: 'IRSA answered 503',
    affects: ['obs:spherex_0001'],
  },
  {
    code: 'SINGLE_EPOCH',
    severity: 'blocker',
    message: 'Only one epoch covers this field',
    detail: 'A difference needs two epochs',
    affects: ['difference'],
  },
  {
    code: 'NO_OBSERVATIONS',
    severity: 'error',
    message: 'No SPHEREx observations here',
    detail: '',
    affects: ['difference'],
  },
  { code: 'OLD_MANIFEST', severity: 'info', message: 'Rendered by pipeline v1', detail: '', affects: [] },
]

const MANIFEST: Pick<FrameManifest, 'checks' | 'warnings'> = {
  checks: CHECKS,
  warnings: ['Only 1 of 2 cutouts loaded'],
}

describe('evidence checks', () => {
  it('groups by severity from error to note', () => {
    expect(groupBySeverity(CHECKS).map(([severity, items]) => [severity, items.length])).toEqual([
      ['error', 1],
      ['blocker', 1],
      ['warning', 1],
      ['info', 1],
    ])
    expect(groupBySeverity([])).toEqual([])
  })

  it('blocks a feature only for blockers and errors that name it', () => {
    expect(hasBlocker(CHECKS, 'difference')).toBe(true)
    expect(hasBlocker(CHECKS.filter((c) => c.severity === 'warning'), 'difference')).toBe(false)
    expect(hasBlocker(CHECKS, 'stacks')).toBe(false)
  })

  it('finds the checks of one frame by obs_id or index', () => {
    expect(checksForFrame(CHECKS, { index: 0, obs_id: 'spherex_0001' }).map((c) => c.code)).toEqual([
      'CUTOUT_MISSING',
    ])
    expect(checksForFrame(CHECKS, { index: 1, obs_id: 'spherex_0002' })).toEqual([])
    const byIndex: Check[] = [{ ...CHECKS[0], affects: ['frame:3'] }]
    expect(checksForFrame(byIndex, { index: 3, obs_id: 'x' })).toHaveLength(1)
  })

  it('prefers checks and falls back to old warnings as notes', () => {
    expect(manifestChecks(MANIFEST)).toBe(CHECKS)
    const legacy = manifestChecks({ checks: [], warnings: MANIFEST.warnings })
    expect(legacy).toEqual([
      {
        code: 'WARNING',
        severity: 'info',
        message: 'Only 1 of 2 cutouts loaded',
        detail: '',
        affects: [],
      },
    ])
    expect(manifestChecks({ checks: [], warnings: [] })).toEqual([])
  })
})

describe('pixel flags', () => {
  const frame = (index: number, obs_id: string, masked_fraction: number | null) =>
    ({ index, obs_id, date: '2026-01-01', masked_fraction }) as Frame
  it('lists frames with masked pixels or flags at the target, with a tooltip', () => {
    const flagged: Check = { code: 'FLAGGED_PIXELS', severity: 'warning', message: 'Flagged', detail: 'b: unusable pixels near the target', affects: ['obs:b'] }
    const flags = frameFlags([frame(0, 'a', 0.002), frame(1, 'b', 0), frame(2, 'c', 0.12), frame(3, 'd', null)], [flagged])
    expect(flags.map((f) => [f.frame.obs_id, f.nearTarget])).toEqual([['b', true], ['c', false]])
    expect(flags[0].tip).toContain('unusable pixels near the target')
    expect(flags[1].tip).toContain('12 % of the pixels')
  })
})
