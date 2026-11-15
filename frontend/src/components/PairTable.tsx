import type { ReactNode } from 'react'
import { frameRelease, utcMinute, type BlinkLetter, type BlinkPair } from '../blink'
import { markerPosition, skyToFrame } from '../motion'
import { countSources } from '../sourceLayer'
import { compareWavelengths } from '../spectral'
import type { Frame, FrameManifest, ProperMotion } from '../types'
import type { Prediction } from '../track'
import { WavelengthStrip } from './WavelengthStrip'

type Which = 'a' | 'b'
const LETTERS: Which[] = ['a', 'b']

interface Props {
  frames: Frame[]
  pair: BlinkPair
  // The frame on screen and its letter (null when it is neither A nor B).
  index: number
  letter: BlinkLetter | null
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'collection'> & Partial<Pick<FrameManifest, 'pixel_scale_arcsec'>>
  motion: ProperMotion | null
  predictions?: Prediction[]
  onShow: (which: Which) => void
  onChoose: (which: Which, index: number) => void
  onSwap: () => void
  // Use the frame on screen as A or B.
  onSetShown: (which: Which) => void
}

const utcSecond = (date: string) => `${date.slice(0, 19).replace('T', ' ')} UTC`
// In the frame choice: date and minute; the Observed row and the group label say UTC.
const choiceText = (date: string) => date.slice(0, 16).replace('T', ' ')
export const baselineText = (days: number) => (days >= 365.25 ? `${(days / 365.25).toFixed(2)} yr` : `${days.toFixed(1)} d`)
const lambda = (f: Frame) => (f.wavelength_um == null
  ? `${f.wavelength_min_um.toFixed(2)}–${f.wavelength_max_um.toFixed(2)} µm`
  : `${f.wavelength_um.toFixed(3)} µm${f.bandwidth_um == null ? '' : ` ± ${(f.bandwidth_um / 2).toFixed(3)}`}`)

// The archive's metadata of a frame; a dash where it lists none (or a stack's exposures disagree).
const MISSING = <span className="muted">–</span>
const ifKnown = <T,>(value: T | null | undefined, render: (value: T) => ReactNode) => (value == null ? MISSING : render(value))
const MJD_UNIX_EPOCH = 40587
const DAY_S = 86_400
// ObsCore calib_level 0–4.
const CALIB_LEVELS = ['raw', 'raw, standard format', 'calibrated, science-ready', 'enhanced (mosaic, resampled)', 'analysis product']
// MJD in UTC → "YYYY-MM-DD HH:MM:SS", to the nearest second.
const mjdText = (mjd: number) =>
  new Date(Math.round((mjd - MJD_UNIX_EPOCH) * DAY_S) * 1000).toISOString().slice(0, 19).replace('T', ' ')
const durationText = (s: number) =>
  (s < 600 ? `${Math.round(s)} s` : s < 2 * DAY_S ? `${(s / 3600).toFixed(1)} h` : `${(s / DAY_S).toFixed(1)} d`)
// To the second within one day, else to the minute; and how long it lasted.
const timeSpan = (f: Frame) => {
  if (f.start_mjd == null || f.end_mjd == null) return MISSING
  const [start, end] = [mjdText(f.start_mjd), mjdText(f.end_mjd)]
  const sameDay = start.slice(0, 10) === end.slice(0, 10)
  return `${sameDay ? start : start.slice(0, 16)} → ${sameDay ? end.slice(11) : end.slice(0, 16)} UTC `
    + `(${durationText((f.end_mjd - f.start_mjd) * DAY_S)})`
}
const exposure = (f: Frame) => ifKnown(f.exposure_s, (s) => (f.n_combined > 1
  ? `${f.n_combined} × ${(s / f.n_combined).toFixed(1)} s = ${Math.round(s)} s`
  : `${s.toFixed(1)} s`))
const calibration = (f: Frame) => ifKnown(f.calib_level, (level) => (CALIB_LEVELS[level] ? `${level} · ${CALIB_LEVELS[level]}` : `${level}`))
const instrument = (f: Frame) => [...new Set([f.facility_name, f.instrument_name].filter(Boolean))].join(' ') || MISSING

const VERDICT = {
  same: { tone: 'ok', text: 'same wavelength: brightness compares directly' },
  close: { tone: 'warn', text: 'close wavelengths: part of a brightness change can be colour' },
  different: { tone: 'fail', text: 'different wavelengths: a brightness change can be colour, not change' },
  unknown: { tone: 'warn', text: 'wavelength not reported for one of them' },
} as const

// A and B beside the image, as one comparison table: every fact of the two frames in the same row, so what differs
// stands out; the pair's verdict (baseline, wavelength, release) under it. The column heads choose the frames.
export function PairTable({ frames, pair, index, letter, grid, motion, predictions = [], onShow, onChoose, onSwap, onSetShown }: Props) {
  const a = frames[pair.a]
  const b = frames[pair.b]
  const shown = frames[index]
  const epochGroups = [...new Set(frames.map((f) => f.epoch))].map((epoch) =>
    [epoch, frames.flatMap((f, i) => (f.epoch === epoch ? [i] : []))] as const)
  const releases = [a, b].map((f) => frameRelease(f, grid.collection))
  const wavelength = compareWavelengths(a.wavelength_um, b.wavelength_um, a.detector)
  const verdict = VERDICT[wavelength.verdict]
  const days = Math.abs(b.mjd - a.mjd)

  const cell = (f: Frame, render: (f: Frame) => ReactNode) => <td>{render(f)}</td>
  const row = (label: string, render: (f: Frame) => ReactNode, title?: string) => (
    <tr>
      <th scope="row" title={title}>{label}</th>
      {cell(a, render)}
      {cell(b, render)}
    </tr>
  )
  const sources = (f: Frame) => {
    if (!f.sources) return <span className="muted">not yet</span>
    const counts = countSources(f.sources)
    return <>{counts.detected}{counts.none > 0 && <> · <strong>{counts.none}</strong> unmatched</>}</>
  }
  // One row each where two belong together: what the image is and how long it was exposed; how much of it is usable.
  const image = (f: Frame) => <>{f.n_combined > 1 ? `stack of ${f.n_combined}` : 'single exposure'}
    {f.exposure_s != null && <span className="muted"> · {exposure(f)}</span>}</>
  const quality = (f: Frame) => <>{Math.round(f.coverage * 100)} %
    <span className="muted"> · {f.masked_fraction == null ? 'masked n/a' : `${(f.masked_fraction * 100).toFixed(1)} % masked`}</span></>
  const release = (f: Frame) => <>{frameRelease(f, grid.collection).replace(/^SPHEREx /, '')}
    {f.release_date && <span className="muted"> · {f.release_date.slice(0, 10)}</span>}</>
  const gaia = (f: Frame) => (motion && markerPosition(motion, f.mjd, grid.ra, grid.dec, grid.size_deg) ? '○ in the image' : 'outside the image')
  const track = (f: Frame) => {
    const p = predictions.find((item) => item.mjd === f.mjd)
    if (!p) return <span className="muted">no prediction</span>
    return skyToFrame(p.ra, p.dec, grid.ra, grid.dec, grid.size_deg) ? 'search area in the image' : 'outside the image'
  }

  const head = (which: Which) => {
    const name = which.toUpperCase()
    const other = pair[which === 'a' ? 'b' : 'a']
    return (
      <div className="pair-col-head">
        {/* Pressed while the image shows this letter, like the stamp. */}
        <button type="button" className={`pair-letter ${which}`} aria-pressed={letter === name} aria-label={`Show frame ${name}`}
          onClick={() => onShow(which)}>{name}</button>
        {/* The choice reads as short text (the thumbnails' numbers); the list it opens names every frame by date. */}
        <label className="pair-pick">
          <span aria-hidden="true">frame {pair[which] + 1} of {frames.length} ▾</span>
          <select aria-label={`Frame ${name}`} value={pair[which]} onChange={(event) => onChoose(which, Number(event.target.value))}>
          {epochGroups.map(([epoch, members]) => (
            <optgroup key={epoch} label={`Epoch ${epoch + 1} (UTC)`}>
              {members.map((i) => (
                <option key={frames[i].url} value={i} disabled={i === other}>{choiceText(frames[i].date)}</option>
              ))}
            </optgroup>
          ))}
          </select>
        </label>
      </div>
    )
  }

  return (
    <section className="pair-panel" aria-label="A and B">
      {letter === null && (
        <p className="pair-shown">
          <span>Showing frame {index + 1} of {frames.length} · {utcMinute(shown.date)} · λ {lambda(shown)}</span>
          {LETTERS.map((which) => (
            <button key={which} type="button" className="pair-set" title={`Use observation ${index + 1} as ${which.toUpperCase()}`}
              onClick={() => onSetShown(which)}>Use as {which.toUpperCase()}</button>
          ))}
        </p>
      )}
      <table className="pair-table">
        <thead>
          <tr>
            <td><button type="button" className="pair-swap" onClick={onSwap} aria-label="Swap A and B" title="Swap A and B"><span aria-hidden="true">⇄</span></button></td>
            <th scope="col">{head('a')}</th>
            <th scope="col">{head('b')}</th>
          </tr>
        </thead>
        {/* What a comparison needs, at a glance; everything else the archive says is one click below. */}
        <tbody>
          {row('Observed', (f) => <>{utcSecond(f.date)}{f.date_end && <> → {utcMinute(f.date_end)}</>}</>)}
          {row('Wavelength', (f) => <>λ {lambda(f)}</>, 'Centre wavelength at the target ± half the bandwidth')}
          {row('Image', image, 'Single exposure or a stack of exposures, with its exposure time (t_exptime)')}
          {row('Quality', quality, 'Share of the field with data · pixels flagged as unusable (saturation, cosmic rays, …)')}
          {row('Sources', sources, 'Detected at ≥ 5σ · how many have no Gaia DR3 or AllWISE match (they need verification)')}
          {motion && row('Gaia DR3', gaia, `Predicted position of ${motion.source_id} · µ ${motion.pmra_mas_yr.toFixed(0)}, ${motion.pmdec_mas_yr.toFixed(0)} mas/yr`)}
          {predictions.length > 0 && row('Track', track, 'Where the possible track from your marks puts the object')}
          {row('Data', (f) => <a href={f.source_url} target="_blank" rel="noreferrer">{f.obs_id}</a>, 'The observation at IRSA')}
        </tbody>
      </table>
      <p className={`pair-verdict ${verdict.tone}`}>
        <strong>Δt {baselineText(days)}</strong> · Δλ {wavelength.pct == null ? '–' : `${wavelength.pct.toFixed(2)} %`}: {verdict.text}
        {releases[0] !== releases[1] && <> · releases differ, so calibration can too</>}
      </p>
      <details className="disclosure pair-more">
        <summary>All metadata</summary>
        <table className="pair-table">
          <thead className="sr-only"><tr><td /><th scope="col">A</th><th scope="col">B</th></tr></thead>
          <tbody>
            {row('Time span', timeSpan, 'Start of the first exposure to the end of the last (t_min, t_max)')}
            {row('Resolving power', (f) => ifKnown(f.resolving_power, (r) => `${Number(r.toFixed(1))}`), 'λ/Δλ as the archive lists it (em_res_power)')}
            {row('Spatial resolution', (f) => ifKnown(f.spatial_resolution_arcsec, (v) => `${Number(v.toFixed(3))}″`),
              'Angular resolution as the archive lists it (s_resolution)')}
            {row('Release', release, 'The data release and when IRSA made the image public (obs_release_date); a stack: its last exposure')}
            {row('Calibration', calibration, 'ObsCore calib_level: 0 raw … 2 calibrated, science-ready … 4 analysis product')}
            {row('Instrument', instrument, 'Facility and instrument as the archive lists them')}
            {row('Epoch · MJD', (f) => `${f.epoch + 1} · ${f.mjd.toFixed(5)}`)}
            {row('Level-2 file', (f) => (f.cloud_url ? <a href={f.cloud_url} target="_blank" rel="noreferrer">AWS S3</a> : MISSING),
              'The whole Level-2 image on AWS S3')}
            {row('Archive ID', (f) => ifKnown(f.publisher_did, (id) => <code className="pair-id">{id}</code>),
              'IVOA publisher ID (obs_publisher_did), a click selects it for copying; a stack names its first exposure, like Data')}
          </tbody>
        </table>
        <p className="pair-field muted">
          Field RA {grid.ra.toFixed(5)}° · Dec {grid.dec.toFixed(5)}° · {Number(grid.size_deg.toFixed(4))}°
          {grid.pixel_scale_arcsec != null && ` · ${grid.pixel_scale_arcsec}″/px`}
        </p>
        <WavelengthStrip detector={shown.detector} frame={shown} />
      </details>
    </section>
  )
}
