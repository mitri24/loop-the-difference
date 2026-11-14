import { useState, type CSSProperties, type ReactNode } from 'react'
import { useResizable } from '../useResizable'
import { Resizer } from './Resizer'

interface Props {
  // The heading row: stays when collapsed.
  head: ReactNode
  children: ReactNode
  hidden?: boolean
}

// The observation timeline under the viewer. The top edge sets the height; collapsed, only the heading row stays.
export function BottomBar({ head, children, hidden = false }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const height = useResizable({ id: 'bar-height', axis: 'y', grow: -1, min: 96,
    initial: (v) => Math.min(220, v.height * 0.25), max: (v) => v.height * 0.6 })
  return (
    <section className={collapsed ? 'bottom-bar collapsed' : 'bottom-bar'} aria-label="Observation timeline" hidden={hidden}
      style={{ '--bar-h': `${height.size}px` } as CSSProperties}>
      {!collapsed && <Resizer label="Timeline height" className="resizer-y" handle={height.handleProps} />}
      <div className="bottom-bar-head">
        {head}
        <button type="button" className="collapse-button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Show the timeline' : 'Fold the timeline'}>
          {collapsed ? '▴' : '▾'}<span className="sr-only">{collapsed ? 'Show the timeline' : 'Fold the timeline'}</span>
        </button>
      </div>
      <div className="bottom-bar-body">{children}</div>
    </section>
  )
}
