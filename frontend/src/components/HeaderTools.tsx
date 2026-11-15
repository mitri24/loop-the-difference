import { useState } from 'react'

export interface HeaderTool<T extends string> {
  id: T
  label: string
}

// The controls that are not information – options, sky layers, about – open as a sheet on demand. Wide
// headers show them as buttons; narrow ones fold them into "⋯", as in the UX skill's top bar.
export function HeaderTools<T extends string>({ items, open, onToggle }: {
  items: HeaderTool<T>[]
  open: T | null
  onToggle: (id: T, trigger: HTMLButtonElement) => void
}) {
  const [menu, setMenu] = useState(false)
  const buttons = (inMenu: boolean) => items.map((item) => (
    <button key={item.id} type="button" className="header-tool" data-testid={`${inMenu ? 'menu' : 'open'}-${item.id}`}
      aria-expanded={open === item.id} aria-controls="floating-panel"
      onClick={(event) => { setMenu(false); onToggle(item.id, inMenu ? moreButton(event.currentTarget) : event.currentTarget) }}>
      {item.label}
    </button>
  ))
  return (
    <>
      <span className="header-tools">{buttons(false)}</span>
      <button type="button" className="header-tool header-more" data-testid="header-more" aria-expanded={menu}
        aria-controls="header-more-menu" aria-label="More: options, layers, about" onClick={() => setMenu(!menu)}>⋯</button>
      <div id="header-more-menu" className="header-more-menu" role="group" aria-label="More" hidden={!menu}>{buttons(true)}</div>
    </>
  )
}

// Focus returns to the "⋯" button when a sheet opened from its menu closes: the menu item is gone by then.
const moreButton = (item: HTMLButtonElement) =>
  item.closest('.hud')?.querySelector<HTMLButtonElement>('.header-more') ?? item
