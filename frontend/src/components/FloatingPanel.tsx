import type { CSSProperties, ReactNode, Ref } from 'react'
import { useResizable } from '../useResizable'
import { Resizer } from './Resizer'

interface Props {
  title: string
  headingRef: Ref<HTMLHeadingElement>
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  hidden?: boolean
  wide?: boolean
}

// One panel next to the dock: width handle on its inner edge; on phones a bottom sheet with a height handle.
// Only the body scrolls, and its content reflows with container queries.
export function FloatingPanel({ title, headingRef, onClose, children, actions, hidden = false, wide = false }: Props) {
  const width = useResizable({ id: wide ? 'image-panel-width' : 'panel-width', axis: 'x', grow: -1, min: 320,
    initial: (v) => wide ? Math.min(1280, v.width - 88 - (v.width >= 1100 ? 320 : 0), Math.max(850, v.height + 20)) : 400,
    max: (v) => wide ? Math.min(1280, v.width - 88) : Math.min(v.width * 0.6, 960) })
  const height = useResizable({ id: 'sheet-height', axis: 'y', grow: -1, min: 200,
    initial: (v) => v.height * 0.55, max: (v) => v.height * 0.85 })
  const style = { '--panel-w': `${width.size}px`, '--sheet-h': `${height.size}px` } as CSSProperties
  return (
    <aside id="floating-panel" className={wide ? "fpanel image-browser" : "fpanel"} aria-label={title} style={style} hidden={hidden}>
      <Resizer label="Panel width" className="resizer-x" handle={width.handleProps} />
      <Resizer label="Panel height" className="resizer-y" handle={height.handleProps} />
      <header className="fpanel-header">
        <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close panel" title="Close (Esc)">✕</button>
      </header>
      <div className="fpanel-body">{children}</div>
      {actions && <div className="fpanel-actions">{actions}</div>}
    </aside>
  )
}
