import { isoDate } from '../catalogLayers'
import { dateDomain, groupEpochs, isoToMjd, timeTicks, type EpochSpan } from '../timeAxis'
import type { Frame, Observation } from '../types'
import { ChartFrame, HIT_RADIUS, LegendItem, NearestLayer, tipHandlers } from './Chart'
import { bandColour, scale } from './SpectrumChart'

const DETECTORS = [1, 2, 3, 4, 5, 6]
// Drawn at the measured panel width (ChartFrame); one row per detector.
const ROW = 18
const M = { left: 40, right: 12, top: 24, bottom: 26 }
const H = M.top + ROW * DETECTORS.length + M.bottom

type FrameMark = Pick<Frame, 'obs_id' | 'mjd' | 'date' | 'date_end' | 'detector' | 'n_combined'>

export interface EpochRow extends EpochSpan {
  perDetector: Record<number, number>
}

// Epochs over all detectors, as /api/observations counts them, with the visits per detector.
export function epochRows(observations: Observation[]): EpochRow[] {
  return groupEpochs(observations.map((o) => o.mjd)).map((epoch) => {
    const perDetector: Record<number, number> = {}
    for (const o of observations) {
      if (o.mjd >= epoch.start && o.mjd <= epoch.end)
        perDetector[o.detector] = (perDetector[o.detector] ?? 0) + 1
    }
    return { ...epoch, perDetector }
  })
}

// A stack spans its exposures: from its first date to date_end (its mjd is their mean).
export const frameSpan = (f: FrameMark): [number, number] =>
  f.date_end
    ? [Math.min(f.mjd, isoToMjd(f.date)), Math.max(f.mjd, isoToMjd(f.date_end))]
    : [f.mjd, f.mjd]

export function timelineSummary(
  observations: Observation[],
  epochs: EpochSpan[],
  frames: FrameMark[],
  current: FrameMark | undefined,
): string {
  if (observations.length === 0) return 'No SPHEREx observations at this position'
  const first = isoDate(epochs[0].start)
  const last = isoDate(epochs.at(-1)!.end)
  const parts = [
    `${observations.length} SPHEREx ${observations.length === 1 ? 'observation' : 'observations'}` +
      ` from ${first} to ${last} in ${epochs.length} ${epochs.length === 1 ? 'epoch' : 'epochs'}`,
  ]
  if (frames.length) parts.push(`${frames.length} frames in this comparison`)
  if (current) parts.push(`shown frame from ${isoDate(current.mjd)} on D${current.detector}`)
  return parts.join('; ')
}

export function ObservationTimeline({
  observations,
  frames = [],
  currentIndex,
  detector,
}: {
  observations: Observation[]
  frames?: FrameMark[]
  currentIndex?: number
  detector?: number
}) {
  if (observations.length === 0 && frames.length === 0) {
    return (
      <p className="notice">No SPHEREx observations cover this position, so there is no timeline.</p>
    )
  }
  const epochs = epochRows(observations)
  const current = currentIndex == null ? undefined : frames[currentIndex]
  const selected = detector ?? current?.detector ?? frames[0]?.detector
  const domain = dateDomain([...observations.map((o) => o.mjd), ...frames.flatMap(frameSpan)])
  const rowY = (d: number) => M.top + ROW * (d - 1) + ROW / 2
  const bottom = M.top + ROW * DETECTORS.length

  const legend = (
    <>
      <LegendItem mark={<circle r={3} className="viz-dot" />}>SPHEREx observation</LegendItem>
      {frames.length > 0 && (
        <LegendItem mark={<circle r={4.5} className="viz-frame-mark" />}>frame in this comparison</LegendItem>
      )}
      {current && (
        <LegendItem mark={<circle r={5} className="viz-frame-mark shown" />}>shown frame ({isoDate(current.mjd)})</LegendItem>
      )}
      <LegendItem mark={<rect x={-4} y={-6} width={8} height={12} className="viz-epoch-mark" />}>epoch: no gap over 30 days</LegendItem>
      {selected && (
        <LegendItem mark={<rect x={-6} y={-4} width={12} height={8} className="viz-row-mark" />}>selected detector D{selected}</LegendItem>
      )}
    </>
  )
  const table = (
    <>
      <table>
        <caption>SPHEREx observations per epoch and detector</caption>
        <thead>
          <tr>
            <th scope="col">Epoch</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            {DETECTORS.map((d) => (
              <th key={d} scope="col">
                D{d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {epochs.map((e, i) => (
            <tr key={e.start}>
              <th scope="row">{i + 1}</th>
              <td>{isoDate(e.start)}</td>
              <td>{isoDate(e.end)}</td>
              {DETECTORS.map((d) => (
                <td key={d}>{e.perDetector[d] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {frames.length > 0 && (
        <ol aria-label="Frames in this comparison">
          {frames.map((f, i) => (
            <li key={`${f.obs_id}-${i}`}>
              {f === current ? 'Shown: ' : ''}
              {f.date.slice(0, 10)}
              {f.date_end ? ` to ${f.date_end.slice(0, 10)}` : ''}, D{f.detector}, {f.obs_id}
            </li>
          ))}
        </ol>
      )}
    </>
  )

  return (
    <ChartFrame className="observation-timeline" title="When SPHEREx looked here (UTC)" legend={legend} table={table}>
      {(W, tip) => {
        const x = scale(domain, [M.left, W - M.right])
        return (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
            aria-label={timelineSummary(observations, epochs, frames, current)}>
            {epochs.map((e, i) => (
              <g key={e.start} className="viz-epoch">
                <rect
                  x={x(e.start) - 3}
                  y={M.top}
                  width={Math.max(6, x(e.end) - x(e.start) + 6)}
                  height={bottom - M.top}
                />
                <text className="viz-tick" x={x(e.start) - 3} y={M.top - 8}>
                  Epoch {i + 1}
                </text>
              </g>
            ))}
            {DETECTORS.map((d) => (
              <g key={d} className={d === selected ? 'viz-row selected' : 'viz-row'}>
                {d === selected && (
                  <rect x={2} y={rowY(d) - ROW / 2} width={W - M.right - 2} height={ROW} />
                )}
                <line x1={M.left} x2={W - M.right} y1={rowY(d)} y2={rowY(d)} />
                {/* The detector's band colour beside its name, as in the spectrum legend. */}
                <circle className="viz-row-swatch" cx={M.left - 31} cy={rowY(d)} r={3.5} fill={bandColour(d)} />
                <text className="viz-tick" x={M.left - 6} y={rowY(d) + 4} textAnchor="end">
                  D{d}
                </text>
              </g>
            ))}
            <g className="viz-axis">
              {timeTicks(domain, Math.max(2, Math.floor((W - M.left - M.right) / 80))).map((t) => (
                <g key={t.mjd}>
                  <line x1={x(t.mjd)} x2={x(t.mjd)} y1={bottom} y2={bottom + 4} />
                  <text className="viz-tick" x={x(t.mjd)} y={bottom + 17} textAnchor="middle">
                    {t.label}
                  </text>
                </g>
              ))}
            </g>
            <g className="viz-dots">
              {observations.map((o) => (
                <circle key={`${o.obs_id}-${o.detector}`} cx={x(o.mjd)} cy={rowY(o.detector)} r={3} />
              ))}
            </g>
            {/* The nearest observation within 24 px answers the pointer; the table carries the same data for keyboards. */}
            <NearestLayer tip={tip} x={M.left - HIT_RADIUS} y={M.top} width={W - M.left - M.right + 2 * HIT_RADIUS} height={bottom - M.top}
              points={observations.map((o) => ({ x: x(o.mjd), y: rowY(o.detector), lines: [`${o.date.slice(0, 10)} · D${o.detector}`, o.obs_id] }))} />
            {current && (
              <g className="viz-current">
                <line x1={x(current.mjd)} x2={x(current.mjd)} y1={M.top - 4} y2={bottom} />
              </g>
            )}
            {frames.map((f, i) => {
              const [a, b] = frameSpan(f)
              const shown = f === current
              const lines = [
                `Frame ${i + 1}${shown ? ' (shown)' : ''} · ${f.date.slice(0, 10)}` + (f.date_end ? ` → ${f.date_end.slice(0, 10)}` : ''),
                `D${f.detector} · ${f.n_combined > 1 ? `${f.n_combined} exposures stacked` : f.obs_id}`,
              ]
              return (
                <g key={`${f.obs_id}-${i}`} className={shown ? 'viz-frame shown' : 'viz-frame'} {...tipHandlers(tip, x(a), rowY(f.detector), lines)}>
                  {b > a && <line x1={x(a)} x2={x(b)} y1={rowY(f.detector)} y2={rowY(f.detector)} />}
                  <circle cx={x(a)} cy={rowY(f.detector)} r={shown ? 6 : 5} />
                  <circle className="viz-hit" cx={x(a)} cy={rowY(f.detector)} r={10} />
                </g>
              )
            })}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
