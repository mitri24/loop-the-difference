import type { ResizeHandleProps } from '../useResizable'

interface Props {
  label: string
  handle: ResizeHandleProps
  className?: string
}

// The visible grip of useResizable; only this element takes touch-action:none, the sky keeps its gestures.
export function Resizer({ label, handle, className = '' }: Props) {
  return <div className={`resizer ${className}`.trim()} aria-label={label} title={`${label} · drag, arrow keys, double-click resets`} {...handle} />
}
