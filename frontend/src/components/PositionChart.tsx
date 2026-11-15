import { isoDate } from '../catalogLayers'
import { FOLLOW_PIXELS, resultLine, type PositionPoint, type PositionTrack } from '../positionTrack'
import { TRACK_LABEL } from '../motionTrack'
import { dateDomain, timeTicks } from '../timeAxis'
import { ChartFrame, HIT_RADIUS, LegendItem, Marker, NearestLayer, niceTicks, tickLabel, tipHandlers } from './Chart'
import { bandColour, scale } from './SpectrumChart'

// Two panels with one y-axis each (east above, north below) over one date axis, drawn at the panel's width.
const PANEL = 96
const GAP = 22
const M = { left: 56, right: 12, top: 12, bottom: 38 }
const TOP = { y0: M.top, y1: M.top + PANEL }
const BOTTOM = { y0: M.top + PANEL + GAP, y1: M.top + 2 * PANEL + GAP }
const H = BOTTOM.y1 + M.bottom

type Axis = 'east' | 'north'
const AXES: { axis: Axis; label: string; band: typeof TOP }[] = [
  { axis: 'east', label: 'East (″)', band: TOP },
  { axis: 'north', label: 'North (″)', band: BOTTOM },
]

const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`

// Value first, then when and where: the tooltip and the link's accessible name.
const pointLines = (p: PositionPoint) => [
  `east ${signed(p.east)}″ · north ${signed(p.north)}″ (± ${p.sigma.toFixed(1)}″)`,
  `${p.frame.date.slice(0, 10)} · D${p.frame.detector} · S/N ${p.source.snr.toFixed(0)}`,
  p.source.catalog_id
    ? `${p.source.catalog_id}${p.source.separation_arcsec == null ? '' : ` · ${p.source.separation_arcsec.toFixed(1)}″ away`}`
    : 'no catalogue match',
  p.frame.obs_id,
  ...(p.source.saturated ? ['saturated core, placed by its rim'] : []),
]

function domain(points: PositionPoint[], axis: Axis): [number, number] {
  const values = points.flatMap((p) => [p[axis] - p.sigma, p[axis] + p.sigma, ...(p.predicted ? [p.predicted[axis]] : [])])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = (hi - lo) * 0.08 || 1
  return [lo - pad, hi + pad]
}

export function PositionChart({ track, subject, detector, onFollowTarget }: {
  track: PositionTrack
  // "the target" or "the selected source"
  subject: string
  detector: number
  // Shown while a source from the list is followed: back to the target.
  onFollowTarget?: () => void
}) {
  const title = `Position of ${subject} over time`
  const expected = track.predictedTotal != null ? 'where Gaia DR3 predicts it at the frame’s date' : 'where it was last detected'
  const note = (
    <>
      Offsets on the sky from the first frame with a detection. The nearest detection within {FOLLOW_PIXELS} px of{' '}
      {expected} counts. Bars = 1σ per axis from the S/N, as measured against Gaia DR3 in SPHEREx frames up to S/N 20;
      brighter stars can scatter more. A shift is a candidate that needs verification.
      {onFollowTarget && <> <button type="button" className="text-button" onClick={onFollowTarget}>Follow the target again</button></>}
    </>
  )
  if (track.points.length < 2) {
    return (
      <figure className="viz position-chart">
        <div className="viz-head"><figcaption className="viz-title">{title}</figcaption></div>
        <p className="notice">{resultLine(track)}</p>
        <p className="viz-note">{note}</p>
      </figure>
    )
  }
  return <Plot track={track} title={title} detector={detector} note={note} />
}

function Plot({ track, title, detector, note }: { track: PositionTrack; title: string; detector: number; note: React.ReactNode }) {
  const { points, gaps } = track
  const xd = dateDomain([...points, ...gaps].map((p) => p.frame.mjd))
  const colour = bandColour(detector)
  const saturated = points.some((p) => p.source.saturated)
  const predicted = points.some((p) => p.predicted)
  const legend = (saturated || predicted || gaps.length > 0) && (
    <>
      <LegendItem mark={<circle r={4.5} fill={colour} />}>detection (D{detector})</LegendItem>
      {saturated && (
        <LegendItem mark={<circle r={4} fill="var(--surface-1)" stroke={colour} strokeWidth={1.6} />}>
          saturated core, position less certain
        </LegendItem>
      )}
      {predicted && <LegendItem mark={<line className="viz-predicted" x1={-6} x2={6} y1={0} y2={0} />}>{TRACK_LABEL}</LegendItem>}
      {gaps.length > 0 && <LegendItem mark={<line className="viz-gap" x1={0} x2={0} y1={-5} y2={5} />}>frame without a detection here</LegendItem>}
    </>
  )
  const rows = [
    ...points.map((p) => ({ mjd: p.frame.mjd, key: p.frame.obs_id, cells: [
      p.frame.date.slice(0, 10), p.frame.obs_id, signed(p.east), signed(p.north), p.sigma.toFixed(1),
      p.source.snr.toFixed(0), p.source.catalog_id ?? 'no match',
    ] })),
    ...gaps.map((g) => ({ mjd: g.frame.mjd, key: g.frame.obs_id, cells: [g.frame.date.slice(0, 10), g.frame.obs_id, g.reason] })),
  ].sort((a, b) => a.mjd - b.mjd)
  const table = (
    <table>
      <caption>Offset per frame from the first detection</caption>
      <thead>
        <tr>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Observation</th>
          <th scope="col">East (″)</th>
          <th scope="col">North (″)</th>
          <th scope="col">1σ (″)</th>
          <th scope="col">S/N</th>
          <th scope="col">Catalogue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.length === 3
              ? <><td>{row.cells[0]}</td><td>{row.cells[1]}</td><td colSpan={5}>{row.cells[2]}</td></>
              : row.cells.map((cell, i) => <td key={i}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
  const summary = `${resultLine(track)}. ${points.length} frames with a detection from ${isoDate(points[0].frame.mjd)} to ${isoDate(points.at(-1)!.frame.mjd)}` +
    (gaps.length ? `, ${gaps.length} without` : '')

  return (
    <ChartFrame className="position-chart" title={title} result={resultLine(track)} legend={legend || undefined} table={table} note={note}>
      {(W, tip) => {
        const x = scale(xd, [M.left, W - M.right])
        return (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
            {AXES.map(({ axis, label, band }) => {
              const yd = domain(points, axis)
              const y = scale(yd, [band.y1, band.y0])
              const ticks = niceTicks(yd, 3)
              const line = points.filter((p) => p.predicted).map((p) => `${x(p.frame.mjd)},${y(p.predicted![axis])}`).join(' ')
              return (
                <g key={axis}>
                  <g className="viz-axis">
                    {ticks.values.map((t) => (
                      <g key={t}>
                        <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
                        <text className="viz-tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">{tickLabel(t, ticks)}</text>
                      </g>
                    ))}
                    {yd[0] < 0 && yd[1] > 0 && <line className="viz-zero" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />}
                    <text className="viz-axis-label" x={14} y={(band.y0 + band.y1) / 2} textAnchor="middle"
                      transform={`rotate(-90 14 ${(band.y0 + band.y1) / 2})`}>{label}</text>
                  </g>
                  {line && <polyline className="viz-predicted" points={line} fill="none" />}
                  <NearestLayer tip={tip} x={M.left - HIT_RADIUS} y={band.y0 - HIT_RADIUS} width={W - M.left - M.right + 2 * HIT_RADIUS}
                    height={PANEL + 2 * HIT_RADIUS}
                    points={points.map((p) => ({ x: x(p.frame.mjd), y: y(p[axis]), href: p.frame.source_url, lines: pointLines(p) }))} />
                  {points.map((p) => {
                    const px = x(p.frame.mjd)
                    const lines = pointLines(p)
                    return (
                      // Each point links to its cutout, as in the brightness chart.
                      <a key={p.frame.obs_id} href={p.frame.source_url} target="_blank" rel="noreferrer"
                        aria-label={[...lines, 'open the cutout'].join(' · ')} {...tipHandlers(tip, px, y(p[axis]), lines)}>
                        <g className={p.source.saturated ? 'viz-point flagged' : 'viz-point'}>
                          <line className="viz-errorbar" x1={px} x2={px} y1={y(p[axis] - p.sigma)} y2={y(p[axis] + p.sigma)} stroke={colour} />
                          <Marker shape="circle" x={px} y={y(p[axis])} colour={colour} hollow={p.source.saturated} />
                        </g>
                      </a>
                    )
                  })}
                </g>
              )
            })}
            <g className="viz-axis">
              <line className="viz-baseline" x1={M.left} x2={W - M.right} y1={BOTTOM.y1} y2={BOTTOM.y1} />
              {gaps.map((g) => (
                <line key={g.frame.obs_id} className="viz-gap" x1={x(g.frame.mjd)} x2={x(g.frame.mjd)} y1={BOTTOM.y1 - 6} y2={BOTTOM.y1 + 6}
                  {...tipHandlers(tip, x(g.frame.mjd), BOTTOM.y1, [`${g.frame.date.slice(0, 10)} · no position`, g.reason, g.frame.obs_id])} />
              ))}
              {timeTicks(xd, Math.max(2, Math.floor((W - M.left - M.right) / 90))).map((t) => (
                <text key={t.mjd} className="viz-tick" x={x(t.mjd)} y={BOTTOM.y1 + 18} textAnchor="middle">{t.label}</text>
              ))}
              <text className="viz-axis-label" x={(W + M.left) / 2} y={H - 4} textAnchor="middle">Date (UTC)</text>
            </g>
          </svg>
        )
      }}
    </ChartFrame>
  )
}
