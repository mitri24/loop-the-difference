import { bandText, fingerprintProgress, spectrumPoints, useFingerprint, type FingerprintState } from '../fingerprint'
import { measurementText, visitsText } from '../followup'
import type { Fingerprint, FingerprintRequest } from '../types'
import { CheckList } from './CheckList'
import { Plot } from './SpectrumChart'

export const FINGERPRINT = 'Spectral fingerprint'
const HINT = 'Measures the track in the visits of all six detectors (0.75–5 µm) and tests for methane bands. Loads up to 48 IRSA cutouts; takes minutes.'
const NEEDS_VISITS = 'Needs the archive’s list of this field’s visits.'

function Details({ fingerprint }: { fingerprint: Fingerprint }) {
  const points = spectrumPoints(fingerprint)
  const { bands } = fingerprint.methane
  return (
    <details className="disclosure">
      <summary>{points.length > 0 ? 'Spectrum, CH₄ bands, visits and checks' : 'Visits and checks'}</summary>
      <div className="followup-details">
        {points.length > 0 && <Plot points={points} title="Flux along the track by wavelength" windows={fingerprint.windows} />}
        {bands.length > 0 && (
          <ul className="followup-checks">
            {bands.map((band) => <li key={band.band}><span aria-hidden="true">·</span><span>{bandText(band, fingerprint.windows)}</span></li>)}
          </ul>
        )}
        {fingerprint.points.length > 0 && (
          <ol className="track-check-rows">
            {fingerprint.points.map((p) => (
              <li key={`${p.obs_id}-${p.detector}`}>
                <span>D{p.detector} · {measurementText(p, fingerprint.psf_photometry)}</span>
                <a href={p.source_url} target="_blank" rel="noopener noreferrer">
                  {p.obs_id}<span aria-hidden="true"> ↗</span><span className="sr-only"> (cutout, opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ol>
        )}
        <CheckList checks={fingerprint.checks} />
      </div>
    </details>
  )
}

// After a follow-up signal: the button, then progress, then the CH₄ result first and every detail folded.
export function FingerprintCheck({ request }: { request: () => FingerprintRequest | null }) {
  const state = useFingerprint()
  const asked = request()
  return <FingerprintView state={state} ready={asked != null} start={() => state.start(asked)} />
}

/** The CH₄ result in one line, with the usable visits and the detectors they come from, e.g. "D2, D3, D5". */
export function summaryLine(fingerprint: Fingerprint): string {
  const detectors = [...new Set(spectrumPoints(fingerprint).filter((p) => !p.flagged).map((p) => p.detector))].sort((a, b) => a - b)
  const measured = detectors.length > 0 ? `, ${visitsText(fingerprint.visits_measured)} in ${detectors.map((d) => `D${d}`).join(', ')}` : ''
  return `Fingerprint${measured}: ${fingerprint.methane.summary}`
}

export function FingerprintView({ state: { phase, job, fingerprint, error }, ready = true, start }: {
  state: Omit<FingerprintState, 'start'>
  ready?: boolean
  start: () => void
}) {
  if (phase === 'idle') {
    return (
      <div className="followup">
        <button type="button" onClick={start} disabled={!ready}>{FINGERPRINT}</button>
        <p className="candidate-hint">{ready ? HINT : NEEDS_VISITS}</p>
      </div>
    )
  }
  if (phase === 'sending' || phase === 'running') return <p className="candidate-hint" role="status">{fingerprintProgress(job)}</p>
  if (phase === 'error' || !fingerprint) {
    return (
      <p className="notice error" role="alert">
        Fingerprint unavailable: {error} <button type="button" onClick={start}>Retry</button>
      </p>
    )
  }
  return (
    <div className="followup">
      <p className="track-check-summary">{summaryLine(fingerprint)}</p>
      {!fingerprint.complete && (
        <p className="notice">
          Incomplete: the archive did not answer every request. <button type="button" onClick={start}>Retry</button>
        </p>
      )}
      <Details fingerprint={fingerprint} />
    </div>
  )
}
