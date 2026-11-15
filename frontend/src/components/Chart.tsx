import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'

// One frame for every evidence chart, so the side menu reads as one system (design-system.md "Charts",
// the same anatomy as the analysis ScatterPlot): title row with a Table toggle, legend above the plot,
// the plot drawn at its measured width (11 px text stays 11 px in any panel width), one tooltip that
// follows hover and keyboard focus, the table always there for screen readers.
export const CHART_MIN_W = 260
export const CHART_MAX_W = 760
// A hit area of 24 px around each mark: nobody has to land on an 8 px dot.
export const HIT_RADIUS = 12

export interface Tip {
  x: number
  y: number
  lines: string[]
}

export interface TipControl {
  show: (tip: Tip) => void
  hide: () => void
}

// A callback ref: the observer follows the element when it is mounted again (after the table view).
// A detached or hidden element reports 0 px and keeps the last width.
export function useMeasuredWidth(initial: number) {
  const [width, setWidth] = useState(initial)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!element || typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === 0) return
      const next = Math.round(Math.min(CHART_MAX_W, Math.max(CHART_MIN_W, entry.contentRect.width)))
      setWidth((current) => (current === next ? current : next))
    })
    observer.current.observe(element)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  return [ref, width] as const
}

interface FrameProps {
  className?: string
  title: ReactNode
  // <LegendItem>s; leave out for a single series, the title names it.
  legend?: ReactNode
  // The chart's data as a <table>: visible behind the Table toggle, otherwise for screen readers only.
  table?: ReactNode
  note?: ReactNode
  initialWidth?: number
  children: (width: number, tip: TipControl) => ReactNode
}

export function ChartFrame({ className = '', title, legend, table, note, initialWidth = 320, children }: FrameProps) {
  const [ref, width] = useMeasuredWidth(initialWidth)
  const [tip, setTip] = useState<Tip | null>(null)
  const [showTable, setShowTable] = useState(false)
  const titleId = useId()
  const control = useMemo<TipControl>(() => ({ show: setTip, hide: () => setTip(null) }), [])
  // Flip only when the tooltip (≤ 260 px) would run past the chart's right edge.
  const flip = tip !== null && tip.x > width - 272
  return (
    <figure className={`viz ${className}`.trim()} aria-labelledby={titleId}>
      <div className="viz-head">
        <span className="viz-title" id={titleId}>{title}</span>
        {/* One label; aria-pressed says whether the table is shown. */}
        {table && (
          <button type="button" className="viz-toggle" aria-pressed={showTable} onClick={() => setShowTable((value) => !value)}>
            Table
          </button>
        )}
      </div>
      {legend && !showTable && <ul className="viz-legend">{legend}</ul>}
      {!showTable && (
        <div ref={ref} className="viz-body" onPointerLeave={control.hide}>
          {children(width, control)}
          {tip && (
            <div className={flip ? 'viz-tooltip flip' : 'viz-tooltip'} style={{ left: tip.x, top: tip.y }} aria-hidden="true">
              {tip.lines.map((line, i) => (i === 0 ? <strong key={i}>{line}</strong> : <span key={i}>{line}</span>))}
            </div>
          )}
        </div>
      )}
      {table && <div className={showTable ? 'viz-table-view' : 'viz-table'}>{table}</div>}
      {note && <p className="viz-note">{note}</p>}
    </figure>
  )
}

export interface HoverPoint {
  x: number
  y: number
  lines: string[]
  href?: string
}

// Under the marks: the pointer shows the nearest point within 24 px and a click opens its link, so in a
// dense spectrum the point you see is the point you get. The marks above keep their own hover and focus.
export function NearestLayer({ points, tip, x, y, width, height }: {
  points: HoverPoint[]
  tip: TipControl
  x: number
  y: number
  width: number
  height: number
}) {
  const nearest = (event: MouseEvent<SVGRectElement>) => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!box) return null
    const px = event.clientX - box.left
    const py = event.clientY - box.top
    let best: HoverPoint | null = null
    let distance = HIT_RADIUS * HIT_RADIUS
    for (const point of points) {
      const d = (point.x - px) ** 2 + (point.y - py) ** 2
      if (d <= distance) {
        best = point
        distance = d
      }
    }
    return best
  }
  return (
    <rect className="viz-hit-area" x={x} y={y} width={width} height={height}
      onPointerMove={(event) => {
        const point = nearest(event)
        if (point) tip.show({ x: point.x, y: point.y, lines: point.lines })
        else tip.hide()
      }}
      onClick={(event) => {
        const point = nearest(event)
        if (point?.href) window.open(point.href, '_blank', 'noreferrer')
      }} />
  )
}

// Hover and keyboard focus show the same tooltip; leaving or blurring hides it.
export function tipHandlers(tip: TipControl, x: number, y: number, lines: string[]) {
  const show = () => tip.show({ x, y, lines })
  return { onPointerEnter: show, onFocus: show, onBlur: tip.hide }
}

export function LegendItem({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <li>
      <svg className="viz-swatch" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
        {mark}
      </svg>
      {children}
    </li>
  )
}

// Epochs (visits) by marker shape, in the analysis ScatterPlot's order; colour stays the detector's.
export const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'triangle-down', 'plus'] as const
export type Shape = (typeof SHAPES)[number]
export const shapeOf = (group: number): Shape => SHAPES[group % SHAPES.length]
export const SHAPE_GLYPHS: Record<Shape, string> = {
  circle: '●', square: '■', triangle: '▲', diamond: '◆', 'triangle-down': '▼', plus: '✚',
}

// Filled marks carry a 2 px ring in the chart surface colour; hollow marks (unreliable values) keep
// the surface inside and the colour as outline.
// className: 'viz-mark' for data marks, 'viz-key' for the same shape in a legend.
export function Marker({ shape, x, y, r = 4.5, colour, hollow = false, className = 'viz-mark' }: {
  shape: Shape
  x: number
  y: number
  r?: number
  colour: string
  hollow?: boolean
  className?: string
}) {
  const paint = hollow
    ? { fill: 'var(--surface-1)', stroke: colour, strokeWidth: 1.6 }
    : { fill: colour, stroke: 'var(--surface-1)', strokeWidth: 2, paintOrder: 'stroke' as const }
  switch (shape) {
    case 'square':
      return <rect className={className} x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} rx={1} {...paint} />
    case 'triangle':
      return <path className={className} d={`M${x} ${y - r}L${x + r} ${y + r * 0.8}L${x - r} ${y + r * 0.8}Z`} {...paint} />
    case 'triangle-down':
      return <path className={className} d={`M${x} ${y + r}L${x + r} ${y - r * 0.8}L${x - r} ${y - r * 0.8}Z`} {...paint} />
    case 'diamond':
      return <path className={className} d={`M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`} {...paint} />
    case 'plus': {
      // An outlined cross, so a flagged (hollow) point stays hollow in this shape too.
      const a = r * 0.3
      const d = `M${x - a} ${y - r}H${x + a}V${y - a}H${x + r}V${y + a}H${x + a}V${y + r}H${x - a}V${y + a}H${x - r}V${y - a}H${x - a}Z`
      return <path className={className} d={d} {...paint} />
    }
    default:
      return <circle className={className} cx={x} cy={y} r={r * 0.9} {...paint} />
  }
}

// Round values 1, 2 or 5 × 10ⁿ apart inside the domain, the step and the decimals they need; a flat
// domain keeps its one value.
export function niceTicks([lo, hi]: [number, number], count = 5) {
  if (!(hi > lo)) return { values: [lo], decimals: 2, step: 0 }
  const raw = (hi - lo) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw
  const values: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) values.push(Number(t.toFixed(9)))
  return { values, decimals: Math.max(0, -Math.floor(Math.log10(step))), step }
}

// Axis labels from 10,000 on in K or M with as many decimals as the step needs, so neighbouring ticks never
// read the same (3.605M, 3.610M); below that the plain value with the tick decimals.
export function tickLabel(value: number, ticks: { decimals: number; step: number }) {
  const size = Math.abs(value)
  if (size < 10_000) return value.toFixed(ticks.decimals)
  const [unit, suffix] = size >= 1_000_000 ? [1_000_000, 'M'] : [1_000, 'K']
  const decimals = ticks.step > 0 ? Math.max(0, Math.ceil(-Math.log10(ticks.step / unit) - 1e-9)) : 1
  return `${(value / unit).toFixed(decimals)}${suffix}`
}
