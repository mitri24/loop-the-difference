import { useRef, useState } from 'react'
import { useLightDismiss } from '../useLightDismiss'

export interface HeaderTool<T extends string> {
  id: T
  label: string
}

// A header button that acts at once (Share) instead of opening a sheet.
export interface HeaderAction {
  id: string
  label: string
  title: string
  onClick: () => void
}

// The controls that are not information – options, sky layers, about – open as a sheet on demand; actions such as
// Share act at once. Wide headers show them as buttons; narrow ones fold them into "⋯", as in the UX skill's top bar.
export function HeaderTools<T extends string>({ items, open, onToggle, actions = [] }: {
  items: HeaderTool<T>[]
  open: T | null
  onToggle: (id: T, trigger: HTMLButtonElement) => void
  actions?: HeaderAction[]
}) {
  const [menu, setMenu] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useLightDismiss(menu, setMenu, more, list)
  const buttons = (inMenu: boolean) => [...items.map((item) => (
    <button key={item.id} type="button" className="header-tool" data-testid={`${inMenu ? 'menu' : 'open'}-${item.id}`}
      aria-expanded={open === item.id} aria-controls="floating-panel"
      onClick={(event) => { setMenu(false); onToggle(item.id, inMenu ? moreButton(event.currentTarget) : event.currentTarget) }}>
      {item.label}
    </button>
  )), ...actions.map((action) => (
    <button key={action.id} type="button" className="header-tool" data-testid={`${inMenu ? 'menu' : 'action'}-${action.id}`}
      title={action.title} onClick={() => { setMenu(false); if (inMenu) more.current?.focus(); action.onClick() }}>
      {action.label}
    </button>
  ))]
  const names = [...items, ...actions].map((tool) => tool.label.toLowerCase()).join(', ')
  return (
    <>
      <span className="header-tools">{buttons(false)}</span>
      <button ref={more} type="button" className="header-tool header-more" data-testid="header-more" aria-expanded={menu}
        aria-controls="header-more-menu" aria-label={`More: ${names}`} onClick={() => setMenu(!menu)}>⋯</button>
      <div ref={list} id="header-more-menu" className="header-more-menu" role="group" aria-label="More" hidden={!menu}>{buttons(true)}</div>
    </>
  )
}

// Focus returns to the "⋯" button when a sheet opened from its menu closes: the menu item is gone by then.
const moreButton = (item: HTMLButtonElement) =>
  item.closest('.hud')?.querySelector<HTMLButtonElement>('.header-more') ?? item
