import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface InspectorTab<T extends string> {
  id: T
  label: string
  // A count beside the label (checks, marks); alert = a blocking check.
  count?: number
  alert?: boolean
  content: ReactNode
}

// The menu that replaces the sidebar (workspace brief §1, §6): one card under the overview map with a tab per
// kind of information and one bounded panel below it. Switching tabs never changes the size of the viewer, the
// map or this card; only the panel scrolls. Every panel stays mounted (hidden), so charts, jobs and the analysis
// parts keep their state. Expand lays it wider over the images for wide content (desktop); on phones it opens
// under the images (`open`).
export function Inspector<T extends string>({ id, tabs, active, onSelect, hidden = false, open = false, onClose, expanded = false, onExpand }: {
  id?: string
  tabs: InspectorTab<T>[]
  active: T
  onSelect: (id: T) => void
  hidden?: boolean
  open?: boolean
  onClose?: () => void
  expanded?: boolean
  onExpand?: (expanded: boolean) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  // Manual activation: arrows, Home and End move the focus between tabs; Enter or Space opens one (some tabs start
  // archive lookups, so passing over them must not).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
    const next = i < 0 ? -1 : step ? (i + step + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    event.stopPropagation()
    buttons[next].focus()
  }
  return (
    <section id={id} className={`inspector${open ? ' open' : ''}${expanded ? ' expanded' : ''}`} aria-label="Inspect" hidden={hidden}>
      <div className="inspector-head">
        <div ref={list} role="tablist" aria-label="Inspector tabs" className="inspector-tabs" onKeyDown={onKeyDown}>
          {tabs.map((tab) => (
            <button key={tab.id} id={`inspect-tab-${tab.id}`} type="button" role="tab" data-testid={`inspect-${tab.id}`}
              aria-selected={tab.id === active} aria-controls={`inspect-panel-${tab.id}`} tabIndex={tab.id === active ? 0 : -1}
              onClick={() => onSelect(tab.id)}>
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className={tab.alert ? 'tab-count alert' : 'tab-count'}>{tab.count}{tab.alert && <span className="sr-only"> (blocking)</span>}</span>
              )}
            </button>
          ))}
        </div>
        {onExpand && <button type="button" className="inspector-expand" aria-label={expanded ? 'Dock inspector' : 'Expand inspector'}
          title={expanded ? 'Back under the map (Esc)' : 'Show wider over the images'} onClick={() => onExpand(!expanded)}>
          {expanded ? 'Dock' : 'Expand'}
        </button>}
        {onClose && <button type="button" className="inspector-close" aria-label="Close inspect" onClick={onClose}>✕</button>}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} id={`inspect-panel-${tab.id}`} role="tabpanel" aria-labelledby={`inspect-tab-${tab.id}`}
          className="inspector-panel" hidden={tab.id !== active} tabIndex={0}>
          {tab.content}
        </div>
      ))}
    </section>
  )
}
