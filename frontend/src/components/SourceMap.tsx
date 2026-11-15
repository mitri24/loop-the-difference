import { useMemo } from 'react'
import type { Mark } from '../candidate'
import { MATCHES, MATCH_STYLE, degText } from '../sourceLayer'
import { buildSourceMap, checkFirst, FEATURES, type MapPoint, type SourceMap as Map2D } from '../sourceMap'
import type { Frame } from '../types'
import { ChartFrame, LegendItem, Marker, tipHandlers } from './Chart'

const H = 240
const PAD = 14
const CHECK_FIRST = 5

interface Props {
  frames: Pick<Frame, 'sources'>[]
  pixelScaleArcsec: number
  // Centres the sky on the source (and the user can mark it there).
  onSelect: (ra: number, dec: number) => void
  // The candidate marks: their sources are ringed on the map.
  marks?: Mark[]
}

const colourOf = (point: MapPoint) => `var(--src-${point.group.match})`
const radiusOf = (point: MapPoint) => 3 + Math.min(point.isolation, 12) * 0.45

const valueText = (value: number | null, unit: string) =>
  value === null ? 'not measured' : `${Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1)}${unit ? ` ${unit}` : ''}`

function tipLines(point: MapPoint, frames: number): string[] {
  const { group } = point
  return [
    group.catalogId ?? `${MATCH_STYLE[group.match].word}`,
    `Unusual: ${point.isolation.toFixed(1)} · seen in ${group.detections.length} of ${frames} frames`,
    `RA ${degText(group.ra)} Dec ${degText(group.dec)}`,
    ...FEATURES.map((f, i) => `${f.label}: ${valueText(point.values[i], f.unit)}`),
  ]
}

const pointName = (point: MapPoint) => point.group.catalogId ?? `${MATCH_STYLE[point.group.match].word} at ${degText(point.group.ra)} ${degText(point.group.dec)}`

/**
 * Every source of the shown frames as one point. Similar sources lie close together; size is how far a
 * source is from the field's typical one in all features. The map points to where to look first; it
 * never says what a source is.
 */
export function SourceMap({ frames, pixelScaleArcsec, onSelect, marks = [] }: Props) {
  const map: Map2D = useMemo(() => buildSourceMap(frames, pixelScaleArcsec), [frames, pixelScaleArcsec])
  const marked = useMemo(() => new Set(marks.flatMap((m) => (m.source ? [`${m.source.ra},${m.source.dec}`] : []))), [marks])
  if (map.method === 'none') return <p className="muted">Too few detected sources for a map (at least three are needed).</p>

  const first = checkFirst(map, CHECK_FIRST)
  const us = map.points.map((p) => p.u)
  const vs = map.points.map((p) => p.v)
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]
  const isMarked = (p: MapPoint) => p.group.detections.some((d) => marked.has(`${d.source.ra},${d.source.dec}`))

  return (
    <section className="source-map" aria-label="Source map">
      <ChartFrame
        title={`Source map · ${map.points.length} sources · ${map.method === 'umap' ? 'UMAP' : 'linear projection – few sources'}`}
        legend={MATCHES.filter((m) => map.points.some((p) => p.group.match === m)).map((m) => (
          <LegendItem key={m} mark={<Marker shape="circle" x={0} y={0} colour={`var(--src-${m})`} className="viz-key" />}>
            {MATCH_STYLE[m].word}
          </LegendItem>
        ))}
        note="Similar sources lie close together; the axes have no physical meaning. Bigger points differ more from the field's typical source in all measured features – check them first. A source near the edge of some frames is seen in fewer of them. Unusual is not new: it needs verification."
        table={
          <table>
            <caption>Sources, most unusual first</caption>
            <thead><tr><th>Source</th><th>Unusual</th><th>Frames</th>{FEATURES.map((f) => <th key={f.id}>{f.label}</th>)}</tr></thead>
            <tbody>
              {[...map.points].sort((a, b) => b.isolation - a.isolation).map((p) => (
                <tr key={p.group.key}>
                  <td>{pointName(p)}</td>
                  <td>{p.isolation.toFixed(1)}</td>
                  <td>{p.group.detections.length} / {map.frames}</td>
                  {FEATURES.map((f, i) => <td key={f.id}>{valueText(p.values[i], f.unit)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        }
      >
        {(width, tip) => {
          const x = (u: number) => PAD + ((u - u0) / (u1 - u0 || 1)) * (width - 2 * PAD)
          const y = (v: number) => PAD + ((v1 - v) / (v1 - v0 || 1)) * (H - 2 * PAD)
          // Most unusual drawn last, on top.
          const ordered = [...map.points].sort((a, b) => a.isolation - b.isolation)
          return (
            <svg width={width} height={H} role="img" aria-label="Source map, one point per detected source">
              {ordered.map((p) => {
                const px = x(p.u)
                const py = y(p.v)
                return (
                  // Pointer only: the "Check first" buttons and the Table are the keyboard and screen-reader path.
                  <g key={p.group.key} className="source-map-point" onClick={() => onSelect(p.group.ra, p.group.dec)}
                    {...tipHandlers(tip, px, py, tipLines(p, map.frames))}>
                    {isMarked(p) && <circle cx={px} cy={py} r={radiusOf(p) + 4} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} />}
                    <Marker shape="circle" x={px} y={py} r={radiusOf(p)} colour={colourOf(p)} />
                  </g>
                )
              })}
            </svg>
          )
        }}
      </ChartFrame>
      <h4 className="side-label">Check first</h4>
      <ol className="source-rows">
        {first.map((p) => (
          <li key={p.group.key} className={`src-${p.group.match}`}>
            <button type="button" onClick={() => onSelect(p.group.ra, p.group.dec)}>
              <span className="source-glyph" aria-hidden="true">{MATCH_STYLE[p.group.match].glyph}</span>
              <span className="source-evidence">{pointName(p)}</span>
              <span className="source-numbers">unusual {p.isolation.toFixed(1)} · seen in {p.group.detections.length} of {map.frames} frames</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
