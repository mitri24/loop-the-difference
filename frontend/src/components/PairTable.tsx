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
    return <>{counts.detected} found{counts.none > 0 && <> · <strong>{counts.none}</strong> without catalogue match</>}</>
  }
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
        <tbody>
          {row('Observed', (f) => <>{utcSecond(f.date)}{f.date_end && <> → {utcMinute(f.date_end)}</>}</>)}
          {row('Wavelength', (f) => <>λ {lambda(f)}</>, 'Centre wavelength at the target ± half the bandwidth')}
          {row('Image', (f) => (f.n_combined > 1 ? `stack of ${f.n_combined} exposures` : 'single exposure'))}
          {row('Coverage', (f) => `${Math.round(f.coverage * 100)} %`, 'Share of the field with data')}
          {row('Masked', (f) => (f.masked_fraction == null ? <span className="muted">not reported</span> : `${(f.masked_fraction * 100).toFixed(1)} %`),
            'Pixels flagged as unusable (saturation, cosmic rays, …)')}
          {row('Sources', sources, 'Detected at ≥ 5σ and matched with Gaia DR3 and AllWISE')}
          {row('Release', (f) => frameRelease(f, grid.collection))}
          {row('Epoch · MJD', (f) => `${f.epoch + 1} · ${f.mjd.toFixed(5)}`)}
          {motion && row('Gaia DR3', gaia, `Predicted position of ${motion.source_id} · µ ${motion.pmra_mas_yr.toFixed(0)}, ${motion.pmdec_mas_yr.toFixed(0)} mas/yr`)}
          {predictions.length > 0 && row('Track', track, 'Where the possible track from your marks puts the object')}
          {row('Data', (f) => <><a href={f.source_url} target="_blank" rel="noreferrer">{f.obs_id}</a>
            {f.cloud_url && <> · <a href={f.cloud_url} target="_blank" rel="noreferrer">Level-2 file</a></>}</>)}
        </tbody>
      </table>
      <p className={`pair-verdict ${verdict.tone}`}>
        <strong>Δt {baselineText(days)}</strong> · Δλ {wavelength.pct == null ? '–' : `${wavelength.pct.toFixed(2)} %`}: {verdict.text}
        {releases[0] !== releases[1] && <> · releases differ, so calibration can too</>}
      </p>
      <p className="pair-field muted">
        Field RA {grid.ra.toFixed(5)}° · Dec {grid.dec.toFixed(5)}° · {Number(grid.size_deg.toFixed(4))}°
        {grid.pixel_scale_arcsec != null && ` · ${grid.pixel_scale_arcsec}″/px`}
      </p>
      <details className="disclosure">
        <summary>Where the shown frame sits in wavelength</summary>
        <WavelengthStrip detector={shown.detector} frame={shown} />
      </details>
    </section>
  )
}
