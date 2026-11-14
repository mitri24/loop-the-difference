import { useEffect, useRef, useState } from 'react'
import { createSpectrum, getSpectrumJob } from '../api'
import type { Check, SpectrumJob, SpectrumPoint } from '../types'
import { BrightnessChart } from './BrightnessChart'

// Drawn at the sidebar's width, so 11px text stays 11px.
const W = 320
const H = 200
const M = { left: 64, right: 12, top: 12, bottom: 40 }
const POLL_MS = 2000

// Colour = detector (fixed band tokens), marker shape = epoch, as in the NAS-9 design system.
export const bandColour = (detector: number) => `var(--band-d${detector})`
const SHAPES = ['●', '■', '▲', '◆', '▼', '✚']
const shapeIndex = (epoch: number) => epoch % SHAPES.length
export const epochShape = (epoch: number) => SHAPES[shapeIndex(epoch)]

// Linear map from a data range onto pixels; a flat range maps to the middle.
export function scale([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  return (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0))
}

export function ranges(points: SpectrumPoint[]): {
  x: [number, number]
  y: [number, number]
} {
  const xs = points.map((p) => p.wavelength_um)
  // Flagged fluxes are unreliable: one saturated visit must not squash every other point.
  const clean = points.some((p) => !p.flagged) ? points.filter((p) => !p.flagged) : points
  const lows = clean.map((p) => p.flux_ujy - p.flux_err_ujy)
  const highs = clean.map((p) => p.flux_ujy + p.flux_err_ujy)
  return {
    x: [Math.min(...xs), Math.max(...xs)],
    y: [Math.min(0, ...lows), Math.max(0, ...highs)],
  }
}

// Bright targets reach seven digits; "3.6M" keeps the labels clear of the axis title.
export const fluxTick = (value: number, decimals: number) =>
  Math.abs(value) >= 10_000
    ? value.toLocaleString('en', { notation: 'compact', maximumSignificantDigits: 3 })
    : value.toFixed(decimals)

const ticks = ([a, b]: [number, number], n = 5) =>
  a === b ? [a] : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))

// One missing cutout is one check: count them instead of listing every visit.
export function summarize(checks: Check[]) {
  const missing = checks.filter((c) => c.code === 'CUTOUT_MISSING').length
  return {
    retry: missing
      ? `Retry the ${missing} ${missing === 1 ? 'visit' : 'visits'} the archive did not deliver`
      : 'Build the spectrum again',
    notes: checks.filter((c) => c.code !== 'CUTOUT_MISSING').map((c) => c.detail),
  }
}

// Key by target: the spectrum belongs to one position and starts on request. centerUm and detector
// pick the visits for the brightness-over-time chart, which reuses the same points.
export function SpectrumChart({
  ra,
  dec,
  centerUm,
  detector,
}: {
  ra: string
  dec: string
  centerUm?: number | null
  detector?: number
}) {
  const [job, setJob] = useState<SpectrumJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = job?.status === 'queued' || job?.status === 'started'

  useEffect(() => {
    if (!job || !running) return
    const timer = window.setTimeout(() => {
      getSpectrumJob(job.job_id).then(setJob, (e: Error) => {
        setJob(null)
        setError(e.message)
      })
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [job, running])

  const sending = useRef(false)
  const start = () => {
    if (sending.current) return
    sending.current = true
    setError(null)
    createSpectrum({ ra, dec })
      .then(setJob, (e: Error) => setError(e.message))
      .finally(() => (sending.current = false))
  }
  const spectrum = job?.status === 'finished' ? job.spectrum : null
  const points = spectrum?.points ?? []
  const { retry, notes } = summarize(spectrum?.checks ?? [])

  return (
    <section aria-label="Quick-look spectrum">
      <h3>Quick-look spectrum at the target</h3>
      {!running && (!spectrum || !spectrum.complete) && (
        <button type="button" onClick={start}>
          {spectrum ? retry : 'Build quick-look spectrum from all SPHEREx visits'}
        </button>
      )}
      {job?.status === 'not_found' && (
        <p className="notice">The spectrum expired – build it again.</p>
      )}
      {running && (
        <p className="progress">
          {job.total > 0
            ? `Measuring every visit… ${job.progress}/${job.total}`
            : 'Searching all detectors…'}
        </p>
      )}
      {(error ?? job?.error) && (
        <p className="notice error">Could not build the spectrum: {error ?? job?.error}</p>
      )}
      {spectrum && points.length === 0 && (
        <p className="notice">No visit gave a usable flux at this position.</p>
      )}
      {points.length > 0 && <Plot points={points} />}
      {spectrum && (
        <p className="caveat">
          Quick-look only: aperture flux at the target without aperture correction, one point per
          visit, colour = detector, marker shape = epoch, bars = 1σ from the VARIANCE extension. Changes are candidates that
          need checking. {notes.join(' · ')}
        </p>
      )}
      {points.length > 0 && <BrightnessChart points={points} centerUm={centerUm} detector={detector} />}
    </section>
  )
}

// Flagged points can lie beyond the flux axis: they get an arrow on the edge pointing their way.
export function offScale(py: number): 'above' | 'below' | null {
  return py < M.top ? 'above' : py > H - M.bottom ? 'below' : null
}

const arrow = (px: number, py: number, side: 'above' | 'below') => {
  const tip = side === 'above' ? py - 5 : py + 5
  const base = side === 'above' ? py + 3 : py - 3
  return `M${px} ${tip} L${px - 5} ${base} L${px + 5} ${base} Z`
}

export function Plot({ points }: { points: SpectrumPoint[] }) {
  const { x: xr, y: yr } = ranges(points)
  const x = scale(xr, [M.left, W - M.right])
  const toY = scale(yr, [H - M.bottom, M.top])
  // Points outside the range sit on the plot edge as arrows; the tooltip keeps the real value.
  const y = (v: number) => Math.min(H - M.bottom, Math.max(M.top, toY(v)))
  const epochs = [...new Set(points.map((p) => p.epoch))].sort((a, b) => a - b)
  const detectors = [...new Set(points.map((p) => p.detector))].sort((a, b) => a - b)
  // Whole µJy for bright targets, decimals when the whole axis spans only a few µJy.
  const decimals = yr[1] - yr[0] < 10 ? 1 : 0
  const firstDate = (epoch: number) =>
    points
      .filter((p) => p.epoch === epoch)
      .map((p) => p.date.slice(0, 10))
      .sort()[0]

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Flux against wavelength">
        <g stroke="var(--grid-line)" fill="var(--muted)" fontSize="11">
          {ticks(xr).map((t, i) => (
            <text key={`x${i}`} x={x(t)} y={H - M.bottom + 16} textAnchor="middle" stroke="none">
              {t.toFixed(2)}
            </text>
          ))}
          {ticks(yr).map((t, i) => (
            <g key={`y${i}`}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
              <text x={M.left - 6} y={y(t) + 4} textAnchor="end" stroke="none">
                {fluxTick(t, decimals)}
              </text>
            </g>
          ))}
          <text x={(W + M.left) / 2} y={H - 6} textAnchor="middle" stroke="none">
            Wavelength (µm)
          </text>
          <text
            x={14}
            y={H / 2}
            textAnchor="middle"
            stroke="none"
            transform={`rotate(-90 14 ${H / 2})`}
          >
            Flux (µJy)
          </text>
        </g>
        {points.map((p) => (
          // Each point links to its cutout: provenance one click (or Tab + Enter) away.
          <a key={`${p.obs_id}-${p.detector}`} href={p.source_url} target="_blank" rel="noreferrer">
            <g stroke={bandColour(p.detector)} fill={bandColour(p.detector)}>
              <line
                x1={x(p.wavelength_um)}
                x2={x(p.wavelength_um)}
                y1={y(p.flux_ujy - p.flux_err_ujy)}
                y2={y(p.flux_ujy + p.flux_err_ujy)}
              />
              <PointMark
                px={x(p.wavelength_um)}
                py={toY(p.flux_ujy)}
                edge={y(p.flux_ujy)}
                epoch={p.epoch}
                hollow={p.flagged}
              >
                <title>
                  {`${p.date.slice(0, 10)} · D${p.detector} · ${p.wavelength_um.toFixed(3)} µm · ` +
                    `${p.flux_ujy.toFixed(1)} ± ${p.flux_err_ujy.toFixed(1)} µJy · ${p.obs_id} · ` +
                    (p.flagged ? 'flagged pixels in aperture, flux unreliable · ' : '') +
                    (offScale(toY(p.flux_ujy)) ? 'beyond the flux axis · ' : '') +
                    'open the cutout'}
                </title>
              </PointMark>
            </g>
          </a>
        ))}
      </svg>
      <p className="muted">
        {detectors.map((d) => (
          <span key={`d${d}`} style={{ marginRight: '1em' }}>
            <span style={{ color: bandColour(d) }}>▬</span> D{d}
          </span>
        ))}
        {epochs.map((e) => (
          <span key={e} style={{ marginRight: '1em' }}>
            {epochShape(e)} Epoch {e + 1} ({firstDate(e)})
          </span>
        ))}
        {points.some((p) => p.flagged) && (
          <span style={{ marginRight: '1em' }}>○ flagged pixels in aperture</span>
        )}
        {points.some((p) => offScale(toY(p.flux_ujy))) && (
          <span>▲▼ beyond the flux axis, value and epoch in the tooltip</span>
        )}
      </p>
    </>
  )
}

// A circle inside the axes, an arrow on the edge (py = unclamped, edge = clamped) beyond them.
function PointMark({
  px,
  py,
  edge,
  epoch,
  hollow,
  children,
}: {
  px: number
  py: number
  edge: number
  epoch: number
  hollow?: boolean
  children: React.ReactNode
}) {
  const fill = hollow ? 'var(--bg)' : undefined
  const side = offScale(py)
  return side ? (
    <path d={arrow(px, edge, side)} fill={fill}>
      {children}
    </path>
  ) : shapeIndex(epoch) === 0 ? (
    <circle cx={px} cy={py} r={4} fill={fill}>
      {children}
    </circle>
  ) : (
    <path d={shape(px, py, shapeIndex(epoch))} fill={fill}>
      {children}
    </path>
  )
}

// Square, triangle, diamond, triangle down and plus around (px, py), each about 8 px wide.
const shape = (px: number, py: number, i: number) => {
  const pts = [
    [[-4, -4], [4, -4], [4, 4], [-4, 4]],
    [[0, -5], [4.5, 3.5], [-4.5, 3.5]],
    [[0, -5], [5, 0], [0, 5], [-5, 0]],
    [[0, 5], [4.5, -3.5], [-4.5, -3.5]],
    [[-1.5, -5], [1.5, -5], [1.5, -1.5], [5, -1.5], [5, 1.5], [1.5, 1.5], [1.5, 5], [-1.5, 5], [-1.5, 1.5], [-5, 1.5], [-5, -1.5], [-1.5, -1.5]],
  ][i - 1]
  return `M${pts.map(([dx, dy]) => `${px + dx} ${py + dy}`).join(' L')} Z`
}
