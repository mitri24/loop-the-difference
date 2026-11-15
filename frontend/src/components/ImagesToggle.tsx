import { useId, type KeyboardEvent } from 'react'

export type ImagesKind = 'exposures' | 'stacks'

const OPTIONS: { kind: ImagesKind; label: string; hint: string }[] = [
  { kind: 'exposures', label: 'Exposures', hint: 'Every single exposure: its exact time and wavelength. Best for motion.' },
  { kind: 'stacks', label: 'Stacks', hint: 'One deeper image per epoch: fainter sources show, but motion within an epoch smears.' },
]

// Which images A and B are: single exposures or one stack per epoch. A segmented switch across the column above the
// A/B table, with what the chosen kind is good for written under it (not hidden in a tooltip).
export function ImagesToggle({ value, onChange, disabled = false }: { value: ImagesKind; onChange: (kind: ImagesKind) => void; disabled?: boolean }) {
  const hintId = useId()
  const chosen = OPTIONS.find((o) => o.kind === value) ?? OPTIONS[0]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
    if (!delta || disabled) return
    // The player steps frames on arrow keys; inside the choice they only move the selection.
    event.preventDefault()
    event.stopPropagation()
    const next = OPTIONS[(OPTIONS.findIndex((o) => o.kind === value) + delta + OPTIONS.length) % OPTIONS.length].kind
    onChange(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[value="${next}"]`)?.focus()
  }
  return (
    <div className="images-toggle">
      <span className="side-label" aria-hidden="true">Images</span>
      <div className="segments" role="radiogroup" aria-label="Images" aria-describedby={hintId} onKeyDown={onKeyDown}>
        {OPTIONS.map((option) => (
          <button key={option.kind} type="button" role="radio" value={option.kind} aria-checked={value === option.kind}
            tabIndex={value === option.kind ? 0 : -1} disabled={disabled} onClick={() => onChange(option.kind)}>
            {option.label}
          </button>
        ))}
      </div>
      <p className="images-hint" id={hintId}>{chosen.hint}</p>
    </div>
  )
}
