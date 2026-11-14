export type DockItem<T extends string> = {
  id: T
  label: string
  title: string
  icon: string
  count?: number
  // A blocking check: the badge turns red and names it for screen readers.
  alert?: boolean
}

interface Props<T extends string> {
  items: DockItem<T>[]
  open: T | null
  onToggle: (id: T, trigger: HTMLButtonElement) => void
}

// The right edge (a bottom row on phones): one button per floating panel.
export function Dock<T extends string>({ items, open, onToggle }: Props<T>) {
  return (
    <nav className="dock" aria-label="Workspace panels">
      {items.map((item) => (
        <button key={item.id} type="button" data-testid={`dock-${item.id}`} aria-controls="floating-panel" aria-expanded={open === item.id}
          className={open === item.id ? 'selected' : ''} title={item.title} onClick={(event) => onToggle(item.id, event.currentTarget)}>
          <span className="dock-icon" aria-hidden="true">{item.icon}</span>
          <span className="dock-label">{item.label}</span>
          {item.count != null && item.count > 0 && <span className={item.alert ? 'dock-badge alert' : 'dock-badge'}
            aria-label={item.alert ? `${item.count}, blocking check` : `${item.count}`}>{item.count}</span>}
        </button>
      ))}
    </nav>
  )
}
