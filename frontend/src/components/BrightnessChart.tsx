import { isoDate } from '../catalogLayers'
import { dateDomain, timeTicks } from '../timeAxis'
import type { SpectrumPoint } from '../types'
import { scale } from './SpectrumChart'
import { DETECTOR_RANGES_UM } from './WavelengthStrip'

// Spectral resolving power per detector, as R_BY_DETECTOR in backend/app/frames.py.
export const R_BY_DETECTOR: Record<number, number> = { 1: 41, 2: 41, 3: 41, 4: 35, 5: 110, 6: 130 }
export const MIN_POINTS = 2
// Drawn at the sidebar's width, so 11px text stays 11px.
const W = 320
const H = 200
const M = { left: 52, right: 10, top: 10, bottom: 38 }

export interface WavelengthWindow {
  lo: number
  hi: number
  detector: number
  r: number
}

// ±1/R around the centre: the same "one resolution element" rule as comparable_wavelengths.
export function wavelengthWindow(centerUm: number, detector?: number): WavelengthWindow | null {
  const d =
    detector ??
    Number(
      Object.entries(DETECTOR_RANGES_UM).find(([, [lo, hi]]) => centerUm >= lo && centerUm <= hi)?.[0],
    )
  const r = R_BY_DETECTOR[d]
  if (!r) return null
  return { lo: centerUm * (1 - 1 / r), hi: centerUm * (1 + 1 / r), detector: d, r }
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

// Round values 1, 2 or 5 × 10ⁿ apart inside the domain, and the decimals they need.
export function niceTicks([lo, hi]: [number, number], count = 5) {
  const raw = (hi - lo) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw
  const values: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) values.push(Number(t.toFixed(9)))
  return { values, decimals: Math.max(0, -Math.floor(Math.log10(step))) }
}

export const windowText = (w: WavelengthWindow) =>
  `wavelength window ${w.lo.toFixed(3)}–${w.hi.toFixed(3)} µm (±1/R around the frame, R = ${w.r} for D${w.detector})`

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

  return (
    <figure className="viz brightness-chart">
      <figcaption className="viz-title">Brightness at the target over time</figcaption>
      {!win && (
        <p className="notice">
          The current frame has no known wavelength, so there is no window to compare brightness in.
        </p>
      )}
      {win && shown.length < MIN_POINTS && (
        <p className="notice">
          {shown.length === 0 ? 'No visit' : 'Only one visit'} measured the target within{' '}
          {win.lo.toFixed(3)}–{win.hi.toFixed(3)} µm: too few points to show brightness over
          time.
        </p>
      )}
      {shown.length >= MIN_POINTS && <Plot points={shown} />}
      <p className="viz-note">
        {caption} {shown.length >= MIN_POINTS && `${shown.length} visits. `}
        Bars = 1σ. A change is a candidate that needs verification.
      </p>
    </figure>
  )
}

function Plot({ points }: { points: SpectrumPoint[] }) {
  const xd = dateDomain(points.map((p) => p.mjd))
  const yd = fluxDomain(points)
  const x = scale(xd, [M.left, W - M.right])
  const y = scale(yd, [H - M.bottom, M.top])
  const yTicks = niceTicks(yd)
  const flagged = points.some((p) => p.flagged)
  const summary =
    `Flux of ${points.length} visits from ${isoDate(points[0].mjd)} to ` +
    `${isoDate(points.at(-1)!.mjd)}, between ${Math.min(...points.map((p) => p.flux_ujy)).toFixed(1)} ` +
    `and ${Math.max(...points.map((p) => p.flux_ujy)).toFixed(1)} µJy`

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary}>
        <g className="viz-axis">
          {yTicks.values.map((t) => (
            <g key={t}>
              <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
              <text x={M.left - 6} y={y(t) + 4} textAnchor="end">
                {t.toFixed(yTicks.decimals)}
              </text>
            </g>
          ))}
          {yd[0] < 0 && yd[1] > 0 && (
            <line className="viz-zero" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />
          )}
          {timeTicks(xd, 3).map((t) => (
            <text key={t.mjd} x={x(t.mjd)} y={H - M.bottom + 16} textAnchor="middle">
              {t.label}
            </text>
          ))}
          <text x={(W + M.left) / 2} y={H - 6} textAnchor="middle">
            Date (UTC)
          </text>
          <text x={14} y={H / 2} textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`}>
            Flux (µJy)
          </text>
        </g>
        {points.map((p) => (
          // Each point links to its cutout, as in the spectrum chart.
          <a key={`${p.obs_id}-${p.detector}`} href={p.source_url} target="_blank" rel="noreferrer">
            <g className={p.flagged ? 'viz-point flagged' : 'viz-point'}>
              <line
                x1={x(p.mjd)}
                x2={x(p.mjd)}
                y1={y(p.flux_ujy - p.flux_err_ujy)}
                y2={y(p.flux_ujy + p.flux_err_ujy)}
              />
              <circle cx={x(p.mjd)} cy={y(p.flux_ujy)} r={4}>
                <title>
                  {`${p.date.slice(0, 10)} · D${p.detector} · ${p.wavelength_um.toFixed(3)} µm · ` +
                    `${p.flux_ujy.toFixed(1)} ± ${p.flux_err_ujy.toFixed(1)} µJy · ${p.obs_id} · ` +
                    (p.flagged ? 'flagged pixels in aperture, flux unreliable · ' : '') +
                    'open the cutout'}
                </title>
              </circle>
            </g>
          </a>
        ))}
      </svg>
      {flagged && (
        <ul className="viz-legend">
          <li>
            <span aria-hidden="true">●</span> measured visit
          </li>
          <li>
            <span aria-hidden="true">○</span> flagged pixels in aperture, flux unreliable
          </li>
        </ul>
      )}
      <table className="viz-table">
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
              <td>{p.obs_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
