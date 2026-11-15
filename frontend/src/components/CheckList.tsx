import { checkLines } from '../followup'
import type { Check } from '../types'
import { SEVERITY } from './EvidencePanel'

// The checks of a follow-up or a fingerprint in short: one line per code, the most severe first, a repeated one counted.
export function CheckList({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return null
  return (
    <ul className="followup-checks">
      {checkLines(checks).map(({ code, severity, message, count, detail }) => (
        <li key={code}>
          <span aria-hidden="true">{SEVERITY[severity].icon}</span>
          <span>
            <span className="sr-only">{SEVERITY[severity].word}: </span>{message}{count > 1 && ` (${count}×)`}
            {detail && <span className="candidate-hint"> – {detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
