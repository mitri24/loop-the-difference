import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export type ViewportClass = 'phone' | 'tablet' | 'desktop'
export interface Viewport { width: number; height: number }

// Same breakpoints as styles/shell.css: ≤ 700 px the sheet is a bottom sheet, < 1024 px it overlays the sky.
export const viewportClass = (width: number): ViewportClass => width <= 700 ? 'phone' : width < 1024 ? 'tablet' : 'desktop'

export const STEP_PX = 16
export const clampSize = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)))

// The size change a key asks for; 0 for keys the handle does not handle. `grow` is -1 when the
// handle sits on the leading edge (left or top), so moving it towards the start makes the element larger.
export function keyDelta(key: string, axis: 'x' | 'y', grow: 1 | -1): number {
  const direction = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 }[key] : { ArrowUp: -1, ArrowDown: 1 }[key]
  return direction ? direction * grow * STEP_PX : 0
}

export const storageKey = (id: string, viewport: ViewportClass) => `ltd:size:${id}:${viewport}`

function readSize(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeSize(key: string, value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(value))
  } catch {
    // Private windows and blocked storage: the size still works for this visit.
  }
}

const currentViewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight })

interface Options {
  id: string
  axis: 'x' | 'y'
  grow: 1 | -1
  initial: (viewport: Viewport) => number
  min: number
  max: (viewport: Viewport) => number
}

// A drag handle for one size: pointer drag, ←/→ or ↑/↓ by 16 px, Home or double-click resets.
// The size is kept per viewport class, so a phone sheet height never becomes a desktop panel width.
export function useResizable({ id, axis, grow, initial, min, max }: Options) {
  const [viewport, setViewport] = useState(currentViewport)
  useEffect(() => {
    const onResize = () => setViewport(currentViewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const key = storageKey(id, viewportClass(viewport.width))
  const [stored, setStored] = useState(() => ({ key, size: readSize(key) }))
  if (stored.key !== key) setStored({ key, size: readSize(key) })
  const limit = max(viewport)
  const size = clampSize(stored.size ?? initial(viewport), min, limit)
  const drag = useRef<{ start: number; size: number } | null>(null)

  const resize = (value: number | null) => {
    const next = value === null ? null : clampSize(value, min, limit)
    setStored({ key, size: next })
    writeSize(key, next)
  }
  const position = (event: PointerEvent) => axis === 'x' ? event.clientX : event.clientY

  return {
    size,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
      'aria-valuemin': min,
      'aria-valuemax': Math.max(min, limit),
      'aria-valuenow': size,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { start: position(event), size }
        event.preventDefault()
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        if (drag.current) resize(drag.current.size + grow * (position(event) - drag.current.start))
      },
      onPointerUp: () => { drag.current = null },
      onPointerCancel: () => { drag.current = null },
      onDoubleClick: () => resize(null),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const delta = keyDelta(event.key, axis, grow)
        if (event.key === 'Home') resize(null)
        else if (delta) resize(size + delta)
        else return
        event.preventDefault()
        event.stopPropagation()
      },
    } as const,
  }
}

export type ResizeHandleProps = ReturnType<typeof useResizable>['handleProps']
