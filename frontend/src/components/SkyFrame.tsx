import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useResizable, viewportClass } from '../useResizable'
import { Resizer } from './Resizer'

interface Props {
  // Investigate: the sky becomes a small overview map; Explore: it fills the stage.
  overview: boolean
  children: ReactNode
}

type MapSize = 'docked' | 'expanded' | 'minimized'

// One element for both modes, so Aladin stays mounted and keeps its view, layers and catalogues. In Investigate
// the overview map is docked in the top-right corner, expanded over the page (nothing moves) or minimized to its bar.
export function SkyFrame({ overview, children }: Props) {
  const [size, setSize] = useState<MapSize>(() => viewportClass(window.innerWidth) === 'phone' ? 'minimized' : 'docked')
  // Height of the viewer head: the expanded map starts under it, so the mode switch and the section bar stay free.
  const [below, setBelow] = useState(0)
  const width = useResizable({ id: 'overview-width', axis: 'x', grow: -1, min: 200,
    // At most 40 % of the window: the map shares the width with the search bar, the page and a sheet.
    initial: (v) => Math.min(360, v.width * 0.22), max: (v) => Math.min(v.width * 0.4, 720) })
  // Escape docks an expanded map before it closes a sheet (App closes sheets on Escape). Phones have no expanded map.
  useEffect(() => {
    if (!overview || size !== 'expanded') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLSelectElement
        || viewportClass(window.innerWidth) === 'phone') return
      event.preventDefault()
      setSize('docked')
    }
    document.addEventListener('keydown', onKey)
    const head = document.querySelector<HTMLElement>('.viewer-head')
    const observer = head ? new ResizeObserver(() => setBelow(head.offsetHeight)) : null
    if (head) observer?.observe(head)
    return () => { document.removeEventListener('keydown', onKey); observer?.disconnect() }
  }, [overview, size])
  const className = `sky-area${overview ? ` overview${size === 'minimized' ? ' collapsed' : size === 'expanded' ? ' expanded' : ''}` : ''}`
  return (
    <div className={className} style={{ '--map-w': `${width.size}px`, '--map-below': `${below}px` } as CSSProperties}>
      {overview && size === 'docked' && <Resizer label="Overview map width" className="resizer-x" handle={width.handleProps} />}
      {overview && <div className="overview-bar">
        <span>Overview map</span>
        <span className="overview-actions">
          {size !== 'minimized' && <button type="button" className="overview-expand" title={size === 'expanded' ? 'Back to the corner (Esc)' : 'Show the map large over the page'}
            onClick={() => setSize(size === 'expanded' ? 'docked' : 'expanded')}>{size === 'expanded' ? 'Dock' : 'Expand'}</button>}
          <button type="button" aria-expanded={size !== 'minimized'} onClick={() => setSize(size === 'minimized' ? 'docked' : 'minimized')}>
            {size === 'minimized' ? 'Show map' : 'Minimize'}
          </button>
        </span>
      </div>}
      {children}
    </div>
  )
}
