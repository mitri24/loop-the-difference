import { isoDate } from '../catalogLayers'
import { dateDomain, groupEpochs, isoToMjd, timeTicks, type EpochSpan } from '../timeAxis'
import type { Frame, Observation } from '../types'
import { scale } from './SpectrumChart'

const DETECTORS = [1, 2, 3, 4, 5, 6]
// Drawn at the sidebar's width, so 11px text stays 11px.
const W = 320
const ROW = 18
const M = { left: 28, right: 10, top: 24, bottom: 26 }
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
  const x = scale(domain, [M.left, W - M.right])
  const rowY = (d: number) => M.top + ROW * (d - 1) + ROW / 2
  const bottom = M.top + ROW * DETECTORS.length

  return (
    <figure className="viz observation-timeline">
      <figcaption className="viz-title">When SPHEREx looked here (UTC)</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={timelineSummary(observations, epochs, frames, current)}
      >
        {epochs.map((e, i) => (
          <g key={e.start} className="viz-epoch">
            <rect
              x={x(e.start) - 3}
              y={M.top}
              width={Math.max(6, x(e.end) - x(e.start) + 6)}
              height={bottom - M.top}
            />
            <text x={x(e.start) - 3} y={M.top - 8}>
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
            <text x={M.left - 6} y={rowY(d) + 4} textAnchor="end">
              D{d}
            </text>
          </g>
        ))}
        <g className="viz-axis">
          {timeTicks(domain, 4).map((t) => (
            <g key={t.mjd}>
              <line x1={x(t.mjd)} x2={x(t.mjd)} y1={bottom} y2={bottom + 4} />
              <text x={x(t.mjd)} y={bottom + 17} textAnchor="middle">
                {t.label}
              </text>
            </g>
          ))}
        </g>
        <g className="viz-dots">
          {observations.map((o) => (
            <circle key={`${o.obs_id}-${o.detector}`} cx={x(o.mjd)} cy={rowY(o.detector)} r={2.5}>
              <title>{`${o.date.slice(0, 10)} · D${o.detector} · ${o.obs_id}`}</title>
            </circle>
          ))}
        </g>
        {current && (
          <g className="viz-current">
            <line x1={x(current.mjd)} x2={x(current.mjd)} y1={M.top - 4} y2={bottom} />
          </g>
        )}
        {frames.map((f, i) => {
          const [a, b] = frameSpan(f)
          const shown = f === current
          return (
            <g key={`${f.obs_id}-${i}`} className={shown ? 'viz-frame shown' : 'viz-frame'}>
              {b > a && <line x1={x(a)} x2={x(b)} y1={rowY(f.detector)} y2={rowY(f.detector)} />}
              <circle cx={x(a)} cy={rowY(f.detector)} r={shown ? 6 : 5}>
                <title>
                  {`Frame ${i + 1}${shown ? ' (shown)' : ''} · ${f.date.slice(0, 10)}` +
                    (f.date_end ? ` → ${f.date_end.slice(0, 10)}` : '') +
                    ` · D${f.detector} · ${f.n_combined > 1 ? `${f.n_combined} exposures stacked` : f.obs_id}`}
                </title>
              </circle>
            </g>
          )
        })}
      </svg>
      <ul className="viz-legend">
        <li>
          <span aria-hidden="true">•</span> SPHEREx observation
        </li>
        {frames.length > 0 && (
          <li>
            <span aria-hidden="true">○</span> frame in this comparison
          </li>
        )}
        {current && (
          <li>
            <span aria-hidden="true">◉</span> shown frame ({isoDate(current.mjd)})
          </li>
        )}
        <li>
          <span aria-hidden="true">▯</span> epoch: no gap over 30 days
        </li>
        {selected && <li>outlined row: selected detector D{selected}</li>}
      </ul>
      <div className="viz-table">
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
      </div>
      {frames.length > 0 && (
        <ol className="viz-table" aria-label="Frames in this comparison">
          {frames.map((f, i) => (
            <li key={`${f.obs_id}-${i}`}>
              {f === current ? 'Shown: ' : ''}
              {f.date.slice(0, 10)}
              {f.date_end ? ` to ${f.date_end.slice(0, 10)}` : ''}, D{f.detector}, {f.obs_id}
            </li>
          ))}
        </ol>
      )}
    </figure>
  )
}
