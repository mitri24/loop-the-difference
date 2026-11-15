import { isoDate } from '../catalogLayers'
import { dateDomain, timeTicks } from '../timeAxis'
import type { SpectrumPoint } from '../types'
import { ChartFrame, HIT_RADIUS, LegendItem, Marker, niceTicks, tipHandlers } from './Chart'
import { bandColour, scale } from './SpectrumChart'
import { DETECTOR_RANGES_UM } from './WavelengthStrip'

export { niceTicks }

// Spectral resolving power per detector, as R_BY_DETECTOR in backend/app/frames.py.
export const R_BY_DETECTOR: Record<number, number> = { 1: 41, 2: 41, 3: 41, 4: 35, 5: 110, 6: 130 }
export const MIN_POINTS = 2
// Drawn at the measured panel width (ChartFrame); the height stays fixed.
const H = 200
const M = { left: 56, right: 12, top: 12, bottom: 38 }

export interface WavelengthWindow {
  lo: number
  hi: number
  detector: number
  r: number
}

// ±1/(2R) around the centre: the window is one resolution element wide, so every two points in it
// pass the comparable_wavelengths rule (|Δλ|/λ ≤ 1/R) with each other, not only with the centre.
export function wavelengthWindow(centerUm: number, detector?: number): WavelengthWindow | null {
  const d =
    detector ??
    Number(
      Object.entries(DETECTOR_RANGES_UM).find(([, [lo, hi]]) => centerUm >= lo && centerUm <= hi)?.[0],
    )
  const r = R_BY_DETECTOR[d]
  if (!r) return null
  return { lo: centerUm * (1 - 1 / (2 * r)), hi: centerUm * (1 + 1 / (2 * r)), detector: d, r }
}

export const inWindow = (points: SpectrumPoint[], w: WavelengthWindow) =>
  points
    .filter((p) => p.wavelength_um >= w.lo && p.wavelength_um <= w.hi)
    .sort((a, b) => a.mjd - b.mjd)

export function fluxDomain(points: SpectrumPoint[]): [number, number] {
  const lo = Math.min(...points.map((p) => p.flux_ujy - p.flux_err_ujy))
  const hi = Math.max(...points.map((p) => p.flux_ujy + p.flux_err_ujy))
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1
  return [lo - pad, hi + pad]
}

export const windowText = (w: WavelengthWindow) =>
  `wavelength window ${w.lo.toFixed(3)}–${w.hi.toFixed(3)} µm (one resolution element around the frame, R = ${w.r} for D${w.detector})`

export function BrightnessChart({
  points,
  centerUm,
  detector,
}: {
  points: SpectrumPoint[]
  centerUm?: number | null
  detector?: number
}) {
  const win = centerUm == null ? null : wavelengthWindow(centerUm, detector)
  const shown = win ? inWindow(points, win) : []
  const caption = win
    ? `Quick-look aperture photometry, not calibrated, ${windowText(win)}.`
    : 'Quick-look aperture photometry, not calibrated.'
  const note = (
    <>
      {caption} {shown.length >= MIN_POINTS && `${shown.length} visits. `}
      Bars = 1σ. A change is a candidate that needs verification.
    </>
  )

  if (!win || shown.length < MIN_POINTS) {
    return (
      <figure className="viz brightness-chart">
        <div className="viz-head">
          <figcaption className="viz-title">Brightness at the target over time</figcaption>
        </div>
        {!win && (
          <p className="notice">
            The current frame has no known wavelength, so there is no window to compare brightness in.
          </p>
        )}
        {win && (
          <p className="notice">
            {shown.length === 0 ? 'No visit' : 'Only one visit'} measured the target within{' '}
            {win.lo.toFixed(3)}–{win.hi.toFixed(3)} µm: too few points to show brightness over
            time.
          </p>
        )}
        <p className="viz-note">{note}</p>
      </figure>
    )
  }
  return <Plot points={shown} detector={win.detector} note={note} />
}

// One series (one detector, one wavelength window): the title names it, so the legend only explains
// hollow points when there are any. Colour = the detector's band colour, as in the spectrum.
function Plot({ points, detector, note }: { points: SpectrumPoint[]; detector: number; note: React.ReactNode }) {
  const xd = dateDomain(points.map((p) => p.mjd))
  const yd = fluxDomain(points)
  const y = scale(yd, [H - M.bottom, M.top])
  const yTicks = niceTicks(yd, 4)
  const flagged = points.some((p) => p.flagged)
  const colour = bandColour(detector)
  const summary =
    `Flux of ${points.length} visits from ${isoDate(points[0].mjd)} to ` +
    `${isoDate(points.at(-1)!.mjd)}, between ${Math.min(...points.map((p) => p.flux_ujy)).toFixed(1)} ` +
    `and ${Math.max(...points.map((p) => p.flux_ujy)).toFixed(1)} µJy`
  const legend = flagged && (
    <>
      <LegendItem mark={<circle r={4.5} fill={colour} />}>measured visit (D{detector})</LegendItem>
      <LegendItem mark={<circle r={4} fill="var(--surface-1)" stroke={colour} strokeWidth={1.6} />}>
        flagged pixels in aperture, flux unreliable
      </LegendItem>
    </>
  )
  const table = (
    <table>
      <caption>Flux per visit</caption>
      <thead>
        <tr>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Detector</th>
          <th scope="col">Wavelength (µm)</th>
          <th scope="col">Flux (µJy)</th>
          <th scope="col">Observation</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={`${p.obs_id}-${p.detector}`}>
            <td>{p.date.slice(0, 10)}</td>
            <td>D{p.detector}</td>
            <td>{p.wavelength_um.toFixed(3)}</td>
            <td>
              {p.flux_ujy.toFixed(1)} ± {p.flux_err_ujy.toFixed(1)}
              {p.flagged ? ' (flagged pixels in aperture)' : ''}
            </td>
            <td><a href={p.source_url} target="_blank" rel="noreferrer">{p.obs_id}</a></td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <ChartFrame className="brightness-chart" title="Brightness at the target over time" legend={legend || undefined} table={table} note={note}>
      {(W, tip) => {
        const x = scale(xd, [M.left, W - M.right])
        return (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
            <g className="viz-axis">
              {yTicks.values.map((t) => (
                <g key={t}>
                  <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
                  <text className="viz-tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">
                    {t.toFixed(yTicks.decimals)}
                  </text>
                </g>
              ))}
              {yd[0] < 0 && yd[1] > 0 && (
                <line className="viz-zero" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />
              )}
              <line className="viz-baseline" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
              {timeTicks(xd, Math.max(2, Math.floor((W - M.left - M.right) / 90))).map((t) => (
                <text key={t.mjd} className="viz-tick" x={x(t.mjd)} y={H - M.bottom + 16} textAnchor="middle">
                  {t.label}
                </text>
              ))}
              <text className="viz-axis-label" x={(W + M.left) / 2} y={H - 4} textAnchor="middle">
                Date (UTC)
              </text>
              <text className="viz-axis-label" x={14} y={H / 2} textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`}>
                Flux (µJy)
              </text>
            </g>
            {points.map((p) => {
              const px = x(p.mjd)
              const lines = [
                `${p.flux_ujy.toFixed(1)} ± ${p.flux_err_ujy.toFixed(1)} µJy`,
                `${p.date.slice(0, 10)} · D${p.detector} · ${p.wavelength_um.toFixed(3)} µm`,
                p.obs_id,
                ...(p.flagged ? ['flagged pixels in aperture, flux unreliable'] : []),
              ]
              return (
                // Each point links to its cutout, as in the spectrum chart.
                <a key={`${p.obs_id}-${p.detector}`} href={p.source_url} target="_blank" rel="noreferrer"
                  aria-label={[...lines, 'open the cutout'].join(' · ')} {...tipHandlers(tip, px, y(p.flux_ujy), lines)}>
                  <g className={p.flagged ? 'viz-point flagged' : 'viz-point'}>
                    <line className="viz-errorbar" x1={px} x2={px} y1={y(p.flux_ujy - p.flux_err_ujy)} y2={y(p.flux_ujy + p.flux_err_ujy)}
                      stroke={colour} />
                    <Marker shape="circle" x={px} y={y(p.flux_ujy)} colour={colour} hollow={p.flagged} />
                  </g>
                  <circle className="viz-hit" cx={px} cy={y(p.flux_ujy)} r={HIT_RADIUS} />
                </a>
              )
            })}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
