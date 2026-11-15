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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
    const i = tabs.findIndex((tab) => tab.id === active)
    const next = step ? (i + step + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    // Arrows step frames in the player; inside the menu they only move between tabs.
    event.preventDefault()
    event.stopPropagation()
    onSelect(tabs[next].id)
    list.current?.querySelector<HTMLButtonElement>(`#inspect-tab-${tabs[next].id}`)?.focus()
  }
  return (
    <section id={id} className={`inspector${open ? ' open' : ''}${expanded ? ' expanded' : ''}`} aria-label="Inspect" hidden={hidden}>
      <div className="inspector-head">
        <div ref={list} role="tablist" aria-label="Inspect" className="inspector-tabs" onKeyDown={onKeyDown}>
          {tabs.map((tab) => (
            <button key={tab.id} id={`inspect-tab-${tab.id}`} type="button" role="tab" data-testid={`inspect-${tab.id}`}
              aria-selected={tab.id === active} aria-controls={`inspect-panel-${tab.id}`} tabIndex={tab.id === active ? 0 : -1}
              onClick={() => onSelect(tab.id)}>
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className={tab.alert ? 'tab-count alert' : 'tab-count'}
                  aria-label={tab.alert ? `${tab.count}, blocking check` : `${tab.count}`}>{tab.count}</span>
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
