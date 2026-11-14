import type { Check, CheckSeverity, Frame, FrameManifest } from '../types'

// Status is always icon + word, never colour alone.
export const SEVERITY: Record<CheckSeverity, { icon: string; word: string }> = {
  error: { icon: '✕', word: 'Error' },
  blocker: { icon: '⊘', word: 'Blocked' },
  warning: { icon: '△', word: 'Warning' },
  info: { icon: 'ⓘ', word: 'Note' },
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
      {groups.map(([severity, items]) => (
        <ul key={severity} className={`checks ${severity}`}>
          {items.map((check, i) => (
            <li key={`${check.code}-${i}`}>
              <span className="check-label">
                <span aria-hidden="true">{SEVERITY[severity].icon}</span> {SEVERITY[severity].word}
              </span>
              <span>
                {check.message}
                {check.detail && <small className="muted"> {check.detail}</small>}
              </span>
            </li>
          ))}
        </ul>
      ))}
    </section>
  )
}
