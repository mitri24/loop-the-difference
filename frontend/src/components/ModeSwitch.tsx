import type { KeyboardEvent } from 'react'
import { VIEW_MODES, type ViewMode } from '../url'

const LABELS: Record<ViewMode, { label: string; hint: string }> = {
  exposures: { label: 'Exposures', hint: 'Every single exposure, played in time order' },
  stacks: { label: 'Stacks', hint: 'One combined image per epoch – faint sources appear' },
  difference: { label: 'Difference', hint: 'Later minus earlier epoch – changes stand out' },
}

interface Props {
  value: ViewMode
  onChange: (mode: ViewMode) => void
  // Why the difference mode cannot be chosen right now; undefined means it can.
  differenceBlocked?: string
  // While a target name is being resolved, a mode change would restart the previous target.
  disabled?: boolean
}

export function ModeSwitch({ value, onChange, differenceBlocked, disabled = false }: Props) {
  const enabled = (mode: ViewMode) => mode !== 'difference' || !differenceBlocked
  // A link may open a mode that is disabled here; the group must still be reachable by Tab.
  const focusable = enabled(value) ? value : VIEW_MODES.find(enabled)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!delta || disabled) return
    // The player steps frames on arrow keys; inside the switch they only move the selection.
    event.preventDefault()
    event.stopPropagation()
    const choices = VIEW_MODES.filter(enabled)
    const next = choices[(choices.indexOf(value) + delta + choices.length) % choices.length]
    onChange(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[value="${next}"]`)?.focus()
  }

  return (
    <div className="mode-switch">
      <div role="radiogroup" aria-label="View mode" onKeyDown={onKeyDown}>
        {VIEW_MODES.map((mode) => (
          <button
            type="button"
            key={mode}
            value={mode}
            role="radio"
            aria-checked={mode === value}
            tabIndex={mode === focusable ? 0 : -1}
            title={LABELS[mode].hint}
            disabled={disabled || !enabled(mode)}
            onClick={() => onChange(mode)}
          >
            {LABELS[mode].label}
          </button>
        ))}
      </div>
      {differenceBlocked && <span className="muted">{differenceBlocked}</span>}
    </div>
  )
}
