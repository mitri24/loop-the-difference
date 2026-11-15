import { frameRelease, lambdaText, utcMinute, type BlinkLetter, type BlinkPair } from '../blink'
import { markerPosition, skyToFrame } from '../motion'
import { SEARCH_AREA_LABEL, type Prediction } from '../track'
import type { Frame, FrameManifest, ProperMotion } from '../types'
import { WavelengthStrip } from './WavelengthStrip'

interface Props {
  frame: Frame
  index: number
  count: number
  letter: BlinkLetter | null
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'collection'> & Partial<Pick<FrameManifest, 'pixel_scale_arcsec'>>
  motion: ProperMotion | null
  predictions?: Prediction[]
  // The blink pair: Set A / Set B use the shown frame as A or B.
  pair?: BlinkPair | null
  onSet?: (which: 'a' | 'b') => void
}

const LETTERS = ['a', 'b'] as const

// What the shown frame is (spec §14): only what reading the image needs by default – time, composition, wavelength,
// quality, and the Gaia and track markers when they are on the image – and everything else the data has behind
// "All details" (release, epoch, MJD, field, where λ sits among the detectors, provenance). Fields the archive does
// not report are not invented.
export function FrameDetails({ frame, index, count, letter, grid, motion, predictions = [], pair = null, onSet }: Props) {
  const marker = motion && markerPosition(motion, frame.mjd, grid.ra, grid.dec, grid.size_deg)
  const predicted = predictions.find((p) => p.mjd === frame.mjd)
  const searchArea = predicted && skyToFrame(predicted.ra, predicted.dec, grid.ra, grid.dec, grid.size_deg)
  const composition = frame.n_combined > 1
    ? `Combined observation: ${frame.n_combined} exposures${frame.date_end ? `, ${frame.date.slice(0, 10)} – ${frame.date_end.slice(0, 10)}` : ''}`
    : 'Individual observation'
  return (
    <section className="frame-details" aria-label="Shown frame">
      <div className="frame-details-head">
        <h3>Frame {index + 1} of {count}{letter && <span className="frame-letter"> · {letter}</span>}</h3>
        {pair && onSet && (
          <div className="pair-set">
            {/* The visible words are the name (label in name); pressed = this frame already is A or B. */}
            {LETTERS.map((which) => (
              <button key={which} type="button"
                disabled={pair[which === 'a' ? 'b' : 'a'] === index} aria-pressed={pair[which] === index}
                title={`Use observation ${index + 1} as ${which.toUpperCase()}`} onClick={() => onSet(which)}>
                Set {which.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>
      <dl className="meta">
        <dt>Observed</dt>
        <dd>
          {frame.date.replace('T', ' ').replace('Z', ' UTC')}
          {frame.date_end && ` → ${utcMinute(frame.date_end)}`}
        </dd>
        <dt>Composition</dt>
        <dd>{composition}</dd>
        <dt>Wavelength</dt>
        <dd>D{frame.detector} · {lambdaText(frame)}</dd>
        <dt>Quality</dt>
        <dd>
          {Math.round(frame.coverage * 100)} % covered ·{' '}
          {frame.masked_fraction == null ? 'masked pixels not reported' : `${(frame.masked_fraction * 100).toFixed(1)} % masked`}
        </dd>
        {motion && (
          <>
            <dt>Gaia DR3</dt>
            <dd>
              {motion.source_id} · µ {motion.pmra_mas_yr.toFixed(0)}, {motion.pmdec_mas_yr.toFixed(0)} mas/yr
              {motion.parallax_mas !== null && ` · ϖ ${motion.parallax_mas.toFixed(1)} mas`} ·{' '}
              {marker ? '○ predicted position' : 'predicted position outside this frame'}
            </dd>
          </>
        )}
        {predicted && (
          <>
            <dt>Possible track</dt>
            <dd>{searchArea ? `dashed circle: search area, ${SEARCH_AREA_LABEL}` : 'predicted position outside this frame'}</dd>
          </>
        )}
      </dl>
      <details className="disclosure">
        <summary>All details</summary>
        <dl className="meta">
          <dt>Release</dt>
          <dd>{frameRelease(frame, grid.collection)}</dd>
          <dt>Epoch</dt>
          <dd>{frame.epoch + 1}</dd>
          <dt>MJD</dt>
          <dd>{frame.mjd.toFixed(5)}</dd>
          <dt>Detector range</dt>
          <dd>D{frame.detector} {frame.wavelength_min_um.toFixed(2)}–{frame.wavelength_max_um.toFixed(2)} µm</dd>
          <dt>Field</dt>
          <dd>
            RA {grid.ra.toFixed(5)}° · Dec {grid.dec.toFixed(5)}° · {Number(grid.size_deg.toFixed(4))}° field
            {grid.pixel_scale_arcsec != null && ` · ${grid.pixel_scale_arcsec}″/px`}
          </dd>
          <dt>Source</dt>
          <dd>
            <a href={frame.source_url} target="_blank" rel="noreferrer">
              {frame.obs_id}
            </a>
            {frame.cloud_url && <> · <a href={frame.cloud_url} target="_blank" rel="noreferrer">Level-2 file (AWS S3)</a></>}
          </dd>
        </dl>
        <WavelengthStrip detector={frame.detector} frame={frame} />
      </details>
    </section>
  )
}
