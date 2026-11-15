import type { Check, CheckSeverity, Frame, FrameManifest } from '../types'
import { CANDIDATE_CAVEAT, explainChecks, KIND_TITLE, passedChecks, SEVERITY_ORDER, type CheckActionId, type ExplainedCheck } from '../checkGuide'
import '../styles/evidence.css'
import { CheckDocsLink } from './DataLinks'

// Status is always icon + word, never colour alone. Icons, words and tones follow design-system.md
// (✕ Blocked, ! Caution, i Note), so these checks read like the analysis checks in the same panel.
export const SEVERITY: Record<CheckSeverity, { icon: string; word: string; tone: 'fail' | 'warn' | 'info' }> = {
  error: { icon: '✕', word: 'Error', tone: 'fail' },
  blocker: { icon: '✕', word: 'Blocked', tone: 'fail' },
  warning: { icon: '!', word: 'Caution', tone: 'warn' },
  info: { icon: 'i', word: 'Note', tone: 'info' },
}

export function groupBySeverity(checks: Check[]): [CheckSeverity, Check[]][] {
  return SEVERITY_ORDER.flatMap((severity) => {
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

interface Props {
  checks: Check[]
  // The comparison the checks belong to: adds the checks that passed and the general caveat.
  manifest?: Pick<FrameManifest, 'preview' | 'frames' | 'epochs' | 'release'> | null
  // Wires a check's action (choose a compatible pair, another region, retry) to the workspace.
  onAction?: (action: CheckActionId) => void
  // What the checks refer to. They cover the whole comparison, all its images, not only the shown pair.
  frameLabel?: string
}

function CheckItem({ item, onAction }: { item: ExplainedCheck; onAction?: Props['onAction'] }) {
  const { icon, word, tone } = SEVERITY[item.severity]
  return (
    <li className={`check-item check-item--${tone}`}>
      <span className="check-item__icon" aria-hidden="true">{icon}</span>
      <div>
        <div className="check-item__title">
          <span className="sr-only">{word}: </span>
          {item.title}
          <span className="check-item__label" aria-hidden="true">{word}</span>
        </div>
        {item.text && <p className="check-item__text">{item.text}</p>}
        {item.action && onAction && (
          <button type="button" className="check-item__action" onClick={() => onAction(item.action!.id)}>{item.action.label}</button>
        )}
        {item.details.length > 0 && (
          <details className="check-item__more">
            <summary>Technical details</summary>
            <ul>{item.details.map((detail, i) => <li key={i}>{detail}</li>)}</ul>
            <CheckDocsLink code={item.code} />
          </details>
        )}
      </div>
    </li>
  )
}

// Problems first, grouped by what they mean for the comparison; what passed stays one click away.
export function EvidencePanel({ checks, manifest, onAction, frameLabel }: Props) {
  const groups = explainChecks(checks)
  const passed = manifest ? passedChecks(manifest, checks) : []
  if (manifest && manifest.frames.length > 0) {
    const limits = groups.find((group) => group.kind === 'limit')
    const caveat: ExplainedCheck = { code: 'CANDIDATES', severity: 'info', ...CANDIDATE_CAVEAT, details: [] }
    if (limits) limits.items.push(caveat)
    else groups.splice(groups.filter((group) => group.kind !== 'info').length, 0, { kind: 'limit', items: [caveat] })
  }
  return (
    <section className="evidence" aria-label="Checks for this view">
      {frameLabel && <p className="evidence__subject">Checks for {frameLabel}</p>}
      {groups.length === 0 && passed.length === 0 && <p className="muted">No issues found for this view</p>}
      {groups.map(({ kind, items }) => (
        <section key={kind} className="check-group" aria-label={KIND_TITLE[kind]}>
          <h4 className="check-group__title">{KIND_TITLE[kind]}</h4>
          <ul className="check-list">{items.map((item) => <CheckItem key={item.code} item={item} onAction={onAction} />)}</ul>
        </section>
      ))}
      {passed.length > 0 && (
        <details className="check-group check-passed">
          <summary className="check-group__title">Passed checks · {passed.length}</summary>
          <ul className="check-list">
            {passed.map((check) => (
              <li key={check.code} className="check-item check-item--ok">
                <span className="check-item__icon" aria-hidden="true">✓</span>
                <div>
                  <div className="check-item__title"><span className="sr-only">Passed: </span>{check.title}</div>
                  <p className="check-item__text">{check.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
