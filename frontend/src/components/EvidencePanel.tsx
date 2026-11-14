import type { Check, CheckSeverity, Frame, FrameManifest } from '../types'
import { CheckDocsLink } from './DataLinks'

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

// Pixel flags per frame: share of pixels the SPHEREx pipeline marked unusable, and flags at the target.
export function frameFlags(frames: Frame[], checks: Check[]) {
  return frames.flatMap((frame) => {
    const nearTarget = checksForFrame(checks, frame).filter((check) => check.code === 'FLAGGED_PIXELS')
    const masked = frame.masked_fraction ?? 0
    if (nearTarget.length === 0 && masked < 0.01) return []
    return [{ frame, nearTarget: nearTarget.length > 0, masked,
      tip: [`Frame ${frame.index + 1} · ${frame.obs_id} · ${frame.date}`,
        `${Math.round(masked * 100)} % of the pixels are flagged unusable by the SPHEREx pipeline and masked`,
        ...nearTarget.map((check) => check.detail)].join('\n') }]
  })
}

export function EvidencePanel({ checks, frames = [] }: { checks: Check[]; frames?: Frame[] }) {
  const groups = groupBySeverity(checks)
  const flags = frameFlags(frames, checks)
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
                <CheckDocsLink code={check.code} />
              </span>
            </li>
          ))}
        </ul>
      ))}
      {flags.length > 0 && <>
        <h3 className="flags-title">Pixel flags</h3>
        <ul className="flags" aria-label="Pixel flags per frame">
          {flags.map(({ frame, nearTarget, masked, tip }) => (
            <li key={frame.index} className={`flag flag--${nearTarget ? 'degraded' : 'info'}`} title={tip} tabIndex={0}>
              <span aria-hidden="true">⚑</span> F{frame.index + 1} · {Math.round(masked * 100)} % masked{nearTarget && ' · near target'}
              <span className="sr-only">. {tip}</span>
            </li>
          ))}
        </ul>
      </>}
    </section>
  )
}
