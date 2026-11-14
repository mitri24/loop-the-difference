import { useId, useState, type ReactNode } from 'react'

export const STEP_TITLES = ['Mark A and B', 'Possible track', 'Look back in SPHEREx', 'Older observations', 'Already known?', 'Your verdict'] as const

export type StepStatus = { kind: 'todo' | 'active' | 'done' } | { kind: 'blocked'; reason: string }

const STATUS = {
  todo: { icon: '○', word: 'not started' },
  active: { icon: '◐', word: 'in progress' },
  done: { icon: '✓', word: 'done' },
  blocked: { icon: '⊘', word: 'not possible' },
} as const

export const pending = (status: StepStatus) => status.kind === 'todo' || status.kind === 'active'

// One step of the candidate check: open while it is the current step, otherwise one summary line; a click toggles it.
export function CheckStep({ n, status, summary, current, children }: {
  n: number
  status: StepStatus
  summary?: string
  current: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(current)
  const [wasCurrent, setWasCurrent] = useState(current)
  if (wasCurrent !== current) {
    setWasCurrent(current)
    setOpen(current)
  }
  const body = useId()
  const { icon, word } = STATUS[status.kind]
  return (
    <li className={`check-step ${status.kind}`}>
      <button type="button" className="check-step-head" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <span className="check-step-title">{n} {STEP_TITLES[n - 1]}</span>
        <span className="check-step-status"><span aria-hidden="true">{icon}</span> {word}{status.kind === 'blocked' && `: ${status.reason}`}</span>
        {!open && summary && <span className="check-step-summary">{summary}</span>}
      </button>
      <div id={body} className="check-step-body" hidden={!open}>{children}</div>
    </li>
  )
}
