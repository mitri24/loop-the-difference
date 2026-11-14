import { useState, type CSSProperties, type ReactNode } from 'react'
import { useResizable, viewportClass } from '../useResizable'
import { Resizer } from './Resizer'

interface Props {
  // Investigate: the sky becomes a small overview map; Explore: it fills the stage.
  overview: boolean
  children: ReactNode
}

// One element for both modes, so Aladin stays mounted and keeps its view, layers and catalogues.
export function SkyFrame({ overview, children }: Props) {
  const [collapsed, setCollapsed] = useState(() => viewportClass(window.innerWidth) === 'phone')
  const width = useResizable({ id: 'overview-width', axis: 'x', grow: -1, min: 200,
    initial: (v) => Math.min(360, v.width * 0.22), max: (v) => Math.min(v.width * 0.6, 720) })
  const className = `sky-area${overview ? ' overview' : ''}${overview && collapsed ? ' collapsed' : ''}`
  return (
    <div className={className} style={{ '--map-w': `${width.size}px` } as CSSProperties}>
      {overview && !collapsed && <Resizer label="Overview map width" className="resizer-x" handle={width.handleProps} />}
      {overview && <div className="overview-bar">
        <span>Overview map</span>
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show map' : 'Hide map'}</button>
      </div>}
      {children}
    </div>
  )
}
