import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Check, Frame, FrameManifest } from '../types'
import { checksForFrame, EvidencePanel, groupBySeverity, hasBlocker, manifestChecks } from './EvidencePanel'

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

describe('EvidencePanel', () => {
  const panel = (props: Parameters<typeof EvidencePanel>[0]) => renderToStaticMarkup(<EvidencePanel {...props} />)
  const flagged: Check = { code: 'FLAGGED_PIXELS', severity: 'warning', message: 'Flagged pixels next to the target',
    detail: 'obs1: unusable pixels within 3 px of the target', affects: ['obs:obs1'] }
  const mismatch: Check = { code: 'WAVELENGTH_MISMATCH', severity: 'blocker', message: 'Frames were observed at different wavelengths',
    detail: 'Effective wavelength ranges from 4.410 to 4.510 µm', affects: ['difference'] }
  const final = { preview: false, epochs: 2, release: 'DR1',
    frames: [{ index: 0, obs_id: 'obs0', wavelength_um: 4.7 }, { index: 1, obs_id: 'obs1', wavelength_um: 4.7 }] as Frame[] }

  it('groups problems by meaning and keeps the technical details on demand', () => {
    const html = panel({ checks: [flagged, mismatch] })
    expect(html.indexOf('>Blocking</h4>')).toBeLessThan(html.indexOf('>Scientific limits</h4>'))
    expect(html).toContain('Different wavelengths')
    expect(html).toContain('<summary>Technical details</summary><ul><li>Effective wavelength ranges from 4.410 to 4.510 µm</li></ul>')
    expect(html).not.toContain('check-item__action')
  })

  it('offers a check’s action only where the workspace wires it', () => {
    expect(panel({ checks: [mismatch], onAction: () => undefined })).toContain('class="check-item__action">Choose a compatible pair</button>')
  })

  it('names what the checks refer to, adds the caveat and keeps passed checks in one closed row', () => {
    const html = panel({ checks: [flagged], manifest: final, frameLabel: 'this comparison · 2 images' })
    expect(html).toContain('Checks for this comparison · 2 images')
    expect(html).toContain('Changes are candidates')
    expect(html).toMatch(/<details class="check-group check-passed"><summary class="check-group__title">Passed checks · 5<\/summary>/)
    expect(html).toContain('Images aligned')
    expect(html).not.toContain('Target pixels usable')
  })
})
