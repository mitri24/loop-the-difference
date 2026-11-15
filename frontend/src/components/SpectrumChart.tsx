import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BANDS, bandText, readBands, type Band } from '../bands'
import { createSpectrum, getSpectrumJob } from '../api'
import type { Check, Spectrum, SpectrumJob, SpectrumPoint } from '../types'
import { BrightnessChart } from './BrightnessChart'
import { Skeleton } from './Skeleton'
import { ChartFrame, HIT_RADIUS, LegendItem, Marker, NearestLayer, niceTicks, shapeOf, SHAPE_GLYPHS, tickLabel, tipHandlers } from './Chart'

// Drawn at the measured panel width (ChartFrame); the height stays fixed.
const H = 200
const M = { left: 56, right: 12, top: 12, bottom: 38 }
const POLL_MS = 2000

// Colour = detector (fixed band tokens), marker shape = epoch, as in the NAS-9 design system.
export const bandColour = (detector: number) => `var(--band-d${detector})`
export const epochShape = (epoch: number) => SHAPE_GLYPHS[shapeOf(epoch)]

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

export interface QuickSpectrum {
  job: SpectrumJob | null
  error: string | null
  running: boolean
  spectrum: Spectrum | null
  start: () => void
}

// One quick-look photometry job per position, shared by the Spectrum and the Brightness tab: it starts on request
// in either and both read its points. A new position starts fresh; a late answer for the old one is dropped.
export function useQuickSpectrum(ra: string | null, dec: string | null): QuickSpectrum {
  const key = ra != null && dec != null ? `${ra},${dec}` : null
  const [state, setState] = useState<{ key: string | null; job: SpectrumJob | null; error: string | null }>({ key, job: null, error: null })
  if (state.key !== key) setState({ key, job: null, error: null })
  const live = state.key === key ? state : { key, job: null, error: null }
  const running = live.job?.status === 'queued' || live.job?.status === 'started'

  useEffect(() => {
    const job = live.job
    if (!job || !running) return
    const timer = window.setTimeout(() => {
      getSpectrumJob(job.job_id).then(
        (next) => setState((s) => (s.key === key ? { ...s, job: next } : s)),
        (e: Error) => setState((s) => (s.key === key ? { ...s, job: null, error: e.message } : s)),
      )
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [live.job, running, key])

  // The position whose request is on its way: a second click there is ignored, another position starts.
  const sending = useRef<string | null>(null)
  const start = useCallback(() => {
    const requested = `${ra},${dec}`
    if (ra == null || dec == null || sending.current === requested) return
    sending.current = requested
    setState((s) => ({ ...s, error: null }))
    createSpectrum({ ra, dec })
      .then(
        (job) => setState((s) => (s.key === requested ? { ...s, job } : s)),
        (e: Error) => setState((s) => (s.key === requested ? { ...s, error: e.message } : s)),
      )
      .finally(() => { if (sending.current === requested) sending.current = null })
  }, [ra, dec])

  return { job: live.job, error: live.error, running, spectrum: live.job?.status === 'finished' ? live.job.spectrum : null, start }
}

// Build button, progress and errors of the shared job, the same in both tabs.
function QuickStatus({ quick, build, where = 'the target' }: { quick: QuickSpectrum; build: string; where?: string }) {
  const { job, error, running, spectrum, start } = quick
  const { retry } = summarize(spectrum?.checks ?? [])
  return (
    <>
      {!running && (!spectrum || !spectrum.complete) && (
        <button type="button" className="spectrum-build" onClick={start}>
          {spectrum ? retry : build}
        </button>
      )}
      {job?.status === 'not_found' && <p className="notice">The measurement expired – start it again.</p>}
      {running && job && (
        <div className="tab-loading" aria-busy="true">
          <p className="progress">
            {job.total > 0 ? `Measuring every visit… ${job.progress}/${job.total}` : 'Searching all detectors…'}
          </p>
          <Skeleton variant="chart" />
        </div>
      )}
      {(error ?? job?.error) && <p className="notice error">Could not measure {where}: {error ?? job?.error}</p>}
      {spectrum && spectrum.points.length === 0 && <p className="notice">No visit gave a usable flux at this position.</p>}
    </>
  )
}

// The Measure tab: one measurement of the target in every SPHEREx visit, read two ways – its brightness over time
// (in a narrow window around the shown frame's wavelength: did it change?) and its spectrum (what is it?).
export function SpectrumChart({ quick, centerUm, detector, subject, onBackToTarget }: {
  quick: QuickSpectrum
  centerUm?: number | null
  detector?: number
  // A source picked in the source list instead of the target; null measures the target.
  subject?: string | null
  onBackToTarget?: () => void
}) {
  const points = useMemo(() => quick.spectrum?.points ?? [], [quick.spectrum])
  const { notes } = summarize(quick.spectrum?.checks ?? [])
  const [showBands, setShowBands] = useState(true)
  const readings = useMemo(() => readBands(points), [points])
  const epochs = new Set(points.map((p) => p.epoch)).size
  const where = subject ? 'the source' : 'the target'
  return (
    <section className="quick-measure" aria-label="Quick-look photometry">
      {subject && (
        <p className="notice">
          Measuring <strong>{subject}</strong>, picked in the source list.{' '}
          {onBackToTarget && <button type="button" className="text-button" onClick={onBackToTarget}>Back to the target</button>}
        </p>
      )}
      <QuickStatus quick={quick} build={`Measure ${where} in all SPHEREx visits`} where={where} />
      {points.length > 0 && <BrightnessChart points={points} centerUm={centerUm} detector={detector} />}
      {points.length > 0 && <Plot points={points} bands={showBands ? BANDS : []} title={`Flux at ${where} by wavelength`} />}
      {points.length > 0 && (
        <section className="band-readings" aria-label="Reference molecular bands">
          <label className="check">
            <input type="checkbox" checked={showBands} onChange={(event) => setShowBands(event.target.checked)} /> Reference bands on the chart
          </label>
          <ul>
            {readings.map((r) => (
              <li key={r.band.id} className={`band-${r.status}`}>
                {bandText(r)}
                {r.noisyContinuum && ' · the points around it scatter more than their errors (variability or a blend): read with care'}
              </li>
            ))}
          </ul>
          <p className="muted">
            SPHEREx resolves broad bands only (R ≈ 35–130). A dip is read against a straight continuum fitted on clean points on
            both sides; it is consistent with a band, not proof of a molecule.
            {epochs > 1 && ` The points come from ${epochs} epochs: a moving or variable source mixes them.`}
          </p>
        </section>
      )}
      {quick.spectrum && (
        <p className="caveat">
          Quick-look only: aperture flux at {where}, one point per
          visit, colour = detector, marker shape = epoch, bars = 1σ from the VARIANCE extension. Changes are candidates that
          need checking. {notes.join(' · ')}
        </p>
      )}
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

// Value first, then where and when it was measured: the tooltip, and the link's accessible name.
export function pointLines(p: SpectrumPoint, beyond: boolean): string[] {
  return [
    `${p.flux_ujy.toFixed(1)} ± ${p.flux_err_ujy.toFixed(1)} µJy`,
    `D${p.detector} · ${p.wavelength_um.toFixed(3)} µm · epoch ${p.epoch + 1}`,
    `${p.date.slice(0, 10)} · ${p.obs_id}`,
    ...(p.flagged ? ['flagged pixels in aperture, flux unreliable'] : []),
    ...(beyond ? ['beyond the flux axis'] : []),
  ]
}

// A wavelength window shaded behind the points: a CH₄ band of the fingerprint or a continuum window beside it.
export interface PlotWindow {
  name: string
  lo_um: number
  hi_um: number
  kind: 'band' | 'continuum'
}

export function Plot({ points, title = 'Flux at the target by wavelength', windows = [], bands = [] }: {
  points: SpectrumPoint[]
  title?: string
  windows?: PlotWindow[]
  // Reference molecular bands (NAS-84): a dashed line and a label each.
  bands?: Band[]
}) {
  const { x: xp, y: yr } = ranges(points)
  // Every window stays in view, also one without a visit in it.
  const xr: [number, number] = windows.length === 0 ? xp
    : [Math.min(xp[0], ...windows.map((w) => w.lo_um)), Math.max(xp[1], ...windows.map((w) => w.hi_um))]
  const toY = scale(yr, [H - M.bottom, M.top])
  // Points outside the range sit on the plot edge as arrows; the tooltip keeps the real value.
  const y = (v: number) => Math.min(H - M.bottom, Math.max(M.top, toY(v)))
  const epochs = [...new Set(points.map((p) => p.epoch))].sort((a, b) => a - b)
  const detectors = [...new Set(points.map((p) => p.detector))].sort((a, b) => a - b)
  const flagged = points.some((p) => p.flagged)
  const beyond = points.some((p) => offScale(toY(p.flux_ujy)))
  const yTicks = niceTicks(yr, 4)
  const firstDate = (epoch: number) =>
    points
      .filter((p) => p.epoch === epoch)
      .map((p) => p.date.slice(0, 10))
      .sort()[0]
  const sorted = [...points].sort((a, b) => a.wavelength_um - b.wavelength_um)

  const legend = (
    <>
      {detectors.map((d) => (
        <LegendItem key={`d${d}`} mark={<circle r={5} fill={bandColour(d)} />}>D{d}</LegendItem>
      ))}
      {epochs.map((e) => (
        <LegendItem key={`e${e}`} mark={<Marker shape={shapeOf(e)} x={0} y={0} r={5} colour="var(--text-secondary)" hollow className="viz-key" />}>
          Epoch {e + 1} ({firstDate(e)})
        </LegendItem>
      ))}
      {flagged && (
        <LegendItem mark={<circle r={4} fill="var(--surface-1)" stroke="var(--text-secondary)" strokeWidth={1.6} />}>
          flagged pixels in aperture
        </LegendItem>
      )}
      {beyond && (
        <LegendItem mark={<path d="M0 -5L5 3L-5 3Z" fill="var(--text-secondary)" />}>beyond the flux axis (value in the tooltip)</LegendItem>
      )}
      {windows.some((w) => w.kind === 'band') && <LegendItem mark={<rect className="viz-window band" x={-6} y={-6} width={12} height={12} />}>CH₄ band</LegendItem>}
      {windows.some((w) => w.kind === 'continuum') && (
        <LegendItem mark={<rect className="viz-window continuum" x={-6} y={-6} width={12} height={12} />}>continuum window</LegendItem>
      )}
    </>
  )
  const table = (
    <table>
      <caption>Flux per visit and detector, by wavelength</caption>
      <thead>
        <tr>
          <th scope="col">Wavelength (µm)</th>
          <th scope="col">Detector</th>
          <th scope="col">Flux (µJy)</th>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Epoch</th>
          <th scope="col">Observation</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={`${p.obs_id}-${p.detector}`}>
            <td>{p.wavelength_um.toFixed(3)}</td>
            <td>D{p.detector}</td>
            <td>
              {p.flux_ujy.toFixed(1)} ± {p.flux_err_ujy.toFixed(1)}
              {p.flagged ? ' (flagged pixels in aperture)' : ''}
            </td>
            <td>{p.date.slice(0, 10)}</td>
            <td>{p.epoch + 1}</td>
            {/* Plain text: the chart's points are the links; a link here would be an invisible tab stop. */}
            <td>{p.obs_id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <ChartFrame className="spectrum-chart" title={title} legend={legend} table={table}>
      {(W, tip) => {
        const x = scale(xr, [M.left, W - M.right])
        const xTicks = niceTicks(xr, Math.max(2, Math.floor((W - M.left - M.right) / 70)))
        return (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
            aria-label={`Flux against wavelength: ${points.length} ${points.length === 1 ? 'visit' : 'visits'} on ${detectors.map((d) => `D${d}`).join(', ')}`}>
            {windows.map((w) => (
              <rect key={w.name} className={`viz-window ${w.kind}`} x={x(w.lo_um)} y={M.top} width={Math.max(0, x(w.hi_um) - x(w.lo_um))}
                height={H - M.top - M.bottom}>
                <title>{w.name}</title>
              </rect>
            ))}
            <g className="viz-axis">
              {yTicks.values.map((t) => (
                <g key={`y${t}`}>
                  <line className="viz-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
                  <text className="viz-tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">
                    {tickLabel(t, yTicks)}
                  </text>
                </g>
              ))}
              <line className="viz-baseline" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
              {xTicks.values.map((t) => (
                <text key={`x${t}`} className="viz-tick" x={x(t)} y={H - M.bottom + 16} textAnchor="middle">
                  {t.toFixed(xTicks.decimals)}
                </text>
              ))}
              <text className="viz-axis-label" x={(W + M.left) / 2} y={H - 4} textAnchor="middle">
                Wavelength (µm)
              </text>
              <text className="viz-axis-label" x={14} y={H / 2} textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`}>
                Flux (µJy)
              </text>
            </g>
            {bands.filter((b) => b.centre >= xr[0] && b.centre <= xr[1]).map((b, i) => (
              // Labels on three staggered rows: H₂O, CH₄ and CH₃OH lie 0.2–0.3 µm apart.
              <g key={b.id} className="viz-band" aria-hidden="true">
                <line x1={x(b.centre)} x2={x(b.centre)} y1={M.top} y2={H - M.bottom} stroke="var(--text-secondary)" strokeDasharray="3 3" />
                <text className="viz-tick" x={x(b.centre)} y={M.top + 10 + (i % 3) * 11} textAnchor="middle"
                  paintOrder="stroke" stroke="var(--surface-1)" strokeWidth={3}>{b.molecule.replace(' ice', '')}</text>
              </g>
            ))}
            <NearestLayer tip={tip} x={M.left - HIT_RADIUS} y={M.top - HIT_RADIUS} width={W - M.left - M.right + 2 * HIT_RADIUS}
              height={H - M.top - M.bottom + 2 * HIT_RADIUS}
              points={points.map((p) => ({ x: x(p.wavelength_um), y: y(p.flux_ujy), href: p.source_url,
                lines: pointLines(p, offScale(toY(p.flux_ujy)) !== null) }))} />
            {points.map((p) => {
              const px = x(p.wavelength_um)
              const side = offScale(toY(p.flux_ujy))
              const lines = pointLines(p, side !== null)
              return (
                // Each point links to its cutout: provenance one click (or Tab + Enter) away.
                <a key={`${p.obs_id}-${p.detector}`} href={p.source_url} target="_blank" rel="noreferrer"
                  aria-label={[...lines, 'open the cutout'].join(' · ')} {...tipHandlers(tip, px, y(p.flux_ujy), lines)}>
                  <line className="viz-errorbar" x1={px} x2={px} y1={y(p.flux_ujy - p.flux_err_ujy)} y2={y(p.flux_ujy + p.flux_err_ujy)}
                    stroke={bandColour(p.detector)} />
                  {side ? (
                    <path className="viz-mark" d={arrow(px, y(p.flux_ujy), side)} stroke={bandColour(p.detector)} strokeWidth={1.6}
                      fill={p.flagged ? 'var(--surface-1)' : bandColour(p.detector)} />
                  ) : (
                    <Marker shape={shapeOf(p.epoch)} x={px} y={toY(p.flux_ujy)} colour={bandColour(p.detector)} hollow={p.flagged} />
                  )}
                </a>
              )
            })}
          </svg>
        )
      }}
    </ChartFrame>
  )
}
