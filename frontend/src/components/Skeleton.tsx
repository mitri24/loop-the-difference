import type { CSSProperties } from 'react'
import '../styles/skeleton.css'

export type SkeletonVariant = 'block' | 'image' | 'thumb' | 'chart' | 'line'

interface Props {
  variant?: SkeletonVariant
  // Text placeholders: this many lines of varying width.
  lines?: number
  className?: string
  style?: CSSProperties
}

const LINE_WIDTHS = [92, 76, 84, 64]

// A grey frame that pulses where content is about to appear. It is decorative: the waiting container
// sets aria-busy and keeps its status words for screen readers.
export function Skeleton({ variant = 'block', lines = 1, className = '', style }: Props) {
  if (variant === 'line') {
    return (
      <span className={`skeleton-lines ${className}`.trim()} style={style} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="skeleton skeleton--line" style={{ width: `${LINE_WIDTHS[i % LINE_WIDTHS.length]}%` }} />
        ))}
      </span>
    )
  }
  return <span className={`skeleton skeleton--${variant} ${className}`.trim()} style={style} aria-hidden="true" />
}
