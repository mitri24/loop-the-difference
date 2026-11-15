import type { Check, CheckSeverity, Frame, FrameManifest } from '../types'
import { CheckDocsLink } from './DataLinks'

// Status is always icon + word, never colour alone. Icons, words and tones follow design-system.md
// (✕ Blocked, ! Caution, i Note), so these checks read like the analysis checks in the same panel.
export const SEVERITY: Record<CheckSeverity, { icon: string; word: string; tone: 'fail' | 'warn' | 'info' }> = {
  error: { icon: '✕', word: 'Error', tone: 'fail' },
  blocker: { icon: '✕', word: 'Blocked', tone: 'fail' },
  warning: { icon: '!', word: 'Caution', tone: 'warn' },
  info: { icon: 'i', word: 'Note', tone: 'info' },
}

const ORDER: CheckSeverity[] = ['error', 'blocker', 'warning', 'info']

export function groupBySeverity(checks: Check[]): [CheckSeverity, Check[]][] {
  return ORDER.flatMap((severity) => {
    const items = checks.filter((check) => check.severity === severity)
    return items.length > 0 ? [[severity, items] as [CheckSeverity, Check[]]] : []
  })
}

// A feature named in `affects` (e.g. 'difference') is disabled by a blocker or an error.
export function hasBlocker(checks: Check[], target: string): boolean {
  return checks.some(
    (check) =>
      (check.severity === 'blocker' || check.severity === 'error') &&
      check.affects.includes(target),
  )
}

// `affects` names a frame as `obs:<obs_id>` (backend today) or `frame:<index>`.
export function checksForFrame(checks: Check[], frame: Pick<Frame, 'index' | 'obs_id'>): Check[] {
  return checks.filter(
    (check) =>
      check.affects.includes(`obs:${frame.obs_id}`) || check.affects.includes(`frame:${frame.index}`),
  )
}

// Manifests from before contract v2 only carry `warnings`: keep them visible as notes.
export function manifestChecks(manifest: Pick<FrameManifest, 'checks' | 'warnings'>): Check[] {
  if (manifest.checks.length > 0) return manifest.checks
  return manifest.warnings.map((message) => ({
    code: 'WARNING',
    severity: 'info',
    message,
    detail: '',
    affects: [],
  }))
}

export function CheckBadge({ checks }: { checks: Check[] }) {
  const [worst] = groupBySeverity(checks)
  if (!worst) return null
  const [severity] = worst
  return (
    <span className={`badge ${severity}`} title={checks.map((c) => c.message).join('\n')}>
      <span aria-hidden="true">{SEVERITY[severity].icon}</span> {SEVERITY[severity].word}
      {checks.length > 1 && ` ×${checks.length}`}
    </span>
  )
}

export function EvidencePanel({ checks }: { checks: Check[] }) {
  const groups = groupBySeverity(checks)
  return (
    <section className="evidence" aria-label="Checks for this view">
      {groups.length === 0 && <p className="muted">No issues found for this view</p>}
      {groups.length > 0 && (
        <ul className="check-list">
          {groups.flatMap(([severity, items]) =>
            items.map((check, i) => (
              <li key={`${severity}-${check.code}-${i}`} className={`check-item check-item--${SEVERITY[severity].tone}`}>
                <span className="check-item__icon" aria-hidden="true">{SEVERITY[severity].icon}</span>
                <div>
                  <div className="check-item__title">
                    <span className="sr-only">{SEVERITY[severity].word}: </span>
                    {check.message}
                    <span className="check-item__label" aria-hidden="true">{SEVERITY[severity].word}</span>
                  </div>
                  <div className="check-item__detail">
                    {check.detail}
                    <CheckDocsLink code={check.code} />
                  </div>
                </div>
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  )
}
