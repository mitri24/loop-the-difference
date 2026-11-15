import { useRef, useState, type ReactNode } from 'react'
import { CHALLENGE_TARGETS } from '../targets'
import type { TargetQuery } from '../url'
import { useLightDismiss } from '../useLightDismiss'
import { openTarget } from './TargetForm'

// "RA, Dec" (or two numbers or sexagesimal parts split by space) goes to the backend as coordinates;
// anything with other letters is a name. The backend parses the coordinates (coords.py).
export function splitCoordinates(text: string): Pick<TargetQuery, 'ra' | 'dec'> | null {
  const value = text.trim()
  if (!value || /[a-ce-gi-ln-rt-z]/i.test(value)) return null
  const parts = value.includes(',') ? value.split(',') : value.split(/\s+/)
  if (parts.length !== 2 || parts.some((part) => !/\d/.test(part))) return null
  return { ra: parts[0].trim(), dec: parts[1].trim() }
}

interface Props {
  value: string
  onChange: (value: string) => void
  draft: TargetQuery
  busy: boolean
  onShow: (query: TargetQuery) => void
  onFind: (name: string, base: TargetQuery) => void
  onDraftChange?: (query: TargetQuery) => void
  // Buttons for the on-demand sheets (options, layers, about).
  tools?: ReactNode
}

// Top of the workspace: one input for a name or "RA, Dec" with the example targets and Surprise me beside it, the
// header tools (sheets, Share) at the end. The window's top-right corner belongs to the overview map.
export function SearchBar({ value, onChange, draft, busy, onShow, onFind, onDraftChange, tools }: Props) {
  const [examplesOpen, setExamplesOpen] = useState(false)
  const examplesToggle = useRef<HTMLButtonElement>(null)
  const examples = useRef<HTMLDivElement>(null)
  useLightDismiss(examplesOpen, setExamplesOpen, examplesToggle, examples)
  const submit = () => {
    setExamplesOpen(false)
    const position = splitCoordinates(value)
    if (position) onShow({ ...draft, ...position })
    else if (value.trim()) onFind(value.trim(), draft)
  }
  return (
    <header className="hud" id="workspace-tools">
      <div className="hud-row">
        <span className="brand" title="Loop the Difference · SPHEREx observation workspace"><span className="brand-name">Loop the Difference</span></span>
        <div className="search-group">
          <form className="global-search" role="search" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <span className="search-mark" aria-hidden="true" />
            <label className="sr-only" htmlFor="sky-search">Target name or RA, Dec</label>
            <input id="sky-search" data-testid="sky-search" placeholder="Object name or RA, Dec"
              value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off" />
            <select className="search-band" aria-label="Search band" value={draft.band} disabled={busy}
              onChange={(event) => onDraftChange?.({ ...draft, band: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((band) => <option key={band} value={band}>D{band}</option>)}
            </select>
            <button type="submit" className="primary search-submit" aria-label="Compare" title="Find and compare" disabled={busy || !value.trim()}>
              {busy ? '…' : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>}
            </button>
          </form>
          <button ref={examplesToggle} type="button" className="examples-toggle" aria-expanded={examplesOpen} aria-controls="search-examples" onClick={() => setExamplesOpen(!examplesOpen)}>Examples <span aria-hidden="true">⌄</span></button>
          <div ref={examples} id="search-examples" className="hud-chips" role="group" aria-label="Examples" hidden={!examplesOpen}>
            {CHALLENGE_TARGETS.map((target) => (
              <button type="button" key={target.label} className="chip" disabled={busy} title={target.hint ?? target.label}
                onClick={() => { setExamplesOpen(false); openTarget(target, draft, { onShow, onFind }) }}>{target.label.split(' · ')[0]}</button>
            ))}
            <button type="button" className="chip" disabled={busy} title="Open a random example target"
              onClick={() => { setExamplesOpen(false); openTarget(CHALLENGE_TARGETS[Math.floor(Math.random() * CHALLENGE_TARGETS.length)], draft, { onShow, onFind }) }}>Surprise me</button>
          </div>
        </div>
        <div className="header-actions">{tools}</div>
      </div>
    </header>
  )
}
