import { visitsText } from '../followup'
import { num } from '../track'
import type { Followup } from '../types'
import { ChartFrame, HIT_RADIUS, LegendItem, Marker, NearestLayer, niceTicks, tickLabel } from './Chart'
import { bandColour, scale } from './SpectrumChart'

// Drawn at the measured panel width (ChartFrame); the height stays fixed and small.
const H = 150
const M = { left: 40, right: 14, top: 10, bottom: 36 }
// backend/app/followup.py: SIGNIFICANT_SNR, and MIN_VISITS for a stack (FollowupCheck.test.tsx fails when they drift).
export const SIGNIFICANT_SNR = 5
export const MIN_VISITS = 2
// Round distances for the axis; the tested ones are uniform in 1/d, and so is the axis.
const ROUND_AU = [30, 50, 100, 200, 500, 1000, 5000, 10000, 50000]
const LABEL_GAP_PX = 34

export interface SnrPoint {
  index: number
  distance_au: number
  snr: number
  flux_ujy: number | null
  flux_err_ujy: number | null
  visits: number
}

/** Every assumed distance with a combined S/N, nearest first. */
export const snrPoints = (followup: Followup): SnrPoint[] => followup.hypotheses
  .flatMap(({ distance_au, snr, flux_ujy, flux_err_ujy, visits }, index) =>
    distance_au != null && snr != null ? [{ index, distance_au, snr, flux_ujy, flux_err_ujy, visits }] : [])
  .sort((a, b) => a.distance_au - b.distance_au)

/** The points in runs of neighbouring tested distances: the curve breaks where a distance between two has no S/N. */
export function curveRuns(followup: Followup, points: SnrPoint[]): SnrPoint[][] {
  const gaps = followup.hypotheses.flatMap(({ distance_au, snr }) => (distance_au != null && snr == null ? [distance_au] : []))
  const runs: SnrPoint[][] = []
  points.forEach((p, i) => {
    const prev = points[i - 1]
    if (prev && !gaps.some((au) => au > prev.distance_au && au < p.distance_au)) runs.at(-1)!.push(p)
    else runs.push([p])
  })
  return runs
}

/** Both ends of the distance axis and round distances between them, labels at least LABEL_GAP_PX apart. */
export function distanceTicks(near: number, far: number, x: (au: number) => number): number[] {
  const ticks = [near]
  for (const au of ROUND_AU) {
    if (au > near && au < far && x(au) - x(ticks.at(-1)!) >= LABEL_GAP_PX && x(far) - x(au) >= LABEL_GAP_PX) ticks.push(au)
  }
  return far > near ? [...ticks, far] : ticks
}

const fluxValue = ({ flux_ujy, flux_err_ujy }: SnrPoint) =>
  flux_ujy == null || flux_err_ujy == null ? '–' : `${flux_ujy.toFixed(2)} ± ${flux_err_ujy.toFixed(2)}`

const pointLines = (p: SnrPoint) => [
  `S/N ${p.snr.toFixed(1)} at ${num(p.distance_au, 3)} AU`,
  `${fluxValue(p)} µJy`,
  `${visitsText(p.visits)}${p.visits < MIN_VISITS ? ', no stack' : ''}`,
]

// S/N of the stacked flux over the assumed distances: where along the distance grid flux stands out, if anywhere.
export function FollowupChart({ followup }: { followup: Followup }) {
  const points = snrPoints(followup)
  if (points.length < 2) return null
  const best = points.find((p) => p.index === followup.best) ?? null
  const colour = bandColour(followup.detector)
  const near = points[0].distance_au
  const far = points.at(-1)!.distance_au
  const lo = Math.min(0, ...points.map((p) => p.snr))
  const hi = Math.max(SIGNIFICANT_SNR, ...points.map((p) => p.snr))
  const pad = (hi - lo) * 0.08
  const yd: [number, number] = [lo - pad, hi + pad]
  const y = scale(yd, [H - M.bottom, M.top])
  const yTicks = niceTicks(yd, 3)
  const single = points.some((p) => p.visits < MIN_VISITS)
  const markR = points.length > 24 ? 2.5 : 4
  const summary = `S/N at ${points.length} assumed distances from ${num(near, 2)} to ${num(far, 2)} AU`
    + `${best ? `, best ${best.snr.toFixed(1)} at ${num(best.distance_au, 2)} AU over ${visitsText(best.visits)}` : ''}`
  const legend = (
    <>
      {best && <LegendItem mark={<circle r={5} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} />}>best</LegendItem>}
      {single && <LegendItem mark={<circle r={3.5} fill="var(--surface-1)" stroke={colour} strokeWidth={1.6} />}>one visit, no stack</LegendItem>}
    </>
  )
  const table = (
    <table>
      <caption>S/N per assumed distance, detector D{followup.detector}</caption>
      <thead>
        <tr>
          <th scope="col">Distance (AU)</th>
          <th scope="col">S/N</th>
          <th scope="col">Flux (µJy)</th>
          <th scope="col">Visits</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.index}>
            <td>{num(p.distance_au, 3)}{p.index === followup.best ? ' (best)' : ''}</td>
            <td>{p.snr.toFixed(1)}</td>
            <td>{fluxValue(p)}</td>
            <td>{p.visits}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
  return (
    <ChartFrame className="followup-chart" title="S/N per assumed distance" legend={best || single ? legend : undefined} table={table}
      note={`Flux stacked over the visits at each distance; dashed line: S/N ${SIGNIFICANT_SNR}.`} initialWidth={300}>
      {(W, tip) => {
        const toX = scale([1 / near, 1 / far], [M.left, W - M.right])
        const x = (au: number) => toX(1 / au)
        return (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
            <g className="viz-axis">
              {yTicks.values.map((t) => (
                <g key={t}>
                  <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
                  <text className="viz-tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">{tickLabel(t, yTicks)}</text>
                </g>
              ))}
              {yd[0] < 0 && yd[1] > 0 && <line className="viz-zero" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />}
              <line className="viz-baseline" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
              {distanceTicks(near, far, x).map((au) => (
                <text key={au} className="viz-tick" x={x(au)} y={H - M.bottom + 15} textAnchor="middle">{num(au, 2)}</text>
              ))}
              <text className="viz-axis-label" x={(W + M.left) / 2} y={H - 4} textAnchor="middle">Assumed distance (AU)</text>
              <text className="viz-axis-label" x={12} y={(H - M.bottom + M.top) / 2} textAnchor="middle"
                transform={`rotate(-90 12 ${(H - M.bottom + M.top) / 2})`}>S/N</text>
            </g>
            <line className="followup-threshold" x1={M.left} x2={W - M.right} y1={y(SIGNIFICANT_SNR)} y2={y(SIGNIFICANT_SNR)} />
            {curveRuns(followup, points).filter((run) => run.length > 1).map((run) => (
              <polyline key={run[0].index} className="followup-curve" stroke={colour} points={run.map((p) => `${x(p.distance_au)},${y(p.snr)}`).join(' ')} />
            ))}
            {points.map((p) => (
              <Marker key={p.index} shape="circle" x={x(p.distance_au)} y={y(p.snr)} r={markR} colour={colour} hollow={p.visits < MIN_VISITS} />
            ))}
            {best && <circle className="followup-best" cx={x(best.distance_au)} cy={y(best.snr)} r={markR + 4} />}
            <NearestLayer tip={tip} x={M.left - HIT_RADIUS} y={M.top - HIT_RADIUS} width={W - M.left - M.right + 2 * HIT_RADIUS}
              height={H - M.top - M.bottom + 2 * HIT_RADIUS}
              points={points.map((p) => ({ x: x(p.distance_au), y: y(p.snr), lines: pointLines(p) }))} />
          </svg>
        )
      }}
    </ChartFrame>
  )
}
