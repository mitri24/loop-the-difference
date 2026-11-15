import { utcMinute } from '../blink'
import { SEVERITY_ORDER } from '../checkGuide'
import {
  followupResult, followupResultText, measurementNotes, progressText, shownHypothesis, visitsText, type FollowupState,
} from '../followup'
import { num } from '../track'
import type { Check, Followup, FollowupMeasurement, Observation } from '../types'
import '../styles/followup.css'
import { SEVERITY } from './EvidencePanel'
import { FollowupChart, snrPoints } from './FollowupChart'

export const START = 'Check all SPHEREx visits'
const HINT = 'Measures the flux where the track puts the object in this detector’s other visits within 400 days of the marks and stacks it. Loads up to 48 IRSA cutouts; takes minutes.'
const NEEDS_VISITS = 'Needs the archive’s list of this field’s visits.'

/** One line per check code, the most severe first; a repeated check (one per visit) is counted, not listed. */
export function checkLines(checks: Check[]) {
  const codes = [...new Set(checks.map((c) => c.code))]
  return codes
    .map((code) => {
      const group = checks.filter((c) => c.code === code)
      const severity = SEVERITY_ORDER.find((s) => group.some((c) => c.severity === s)) ?? 'info'
      return { code, severity, message: group[0].message, count: group.length, detail: group.length === 1 ? group[0].detail : '' }
    })
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

/** Date, wavelength, flux, S/N and what qualifies them, for one visit: the PSF flux when the follow-up stacks PSF fluxes. */
export function measurementText(m: FollowupMeasurement, psf: boolean) {
  const [kind, flux, err, snr] = psf && m.psf_flux_ujy != null
    ? ['PSF', m.psf_flux_ujy, m.psf_flux_err_ujy, m.psf_snr]
    : ['aperture', m.flux_ujy, m.flux_err_ujy, m.snr]
  return [
    utcMinute(m.date),
    m.wavelength_um != null ? `${m.wavelength_um.toFixed(3)} µm` : null,
    flux != null && err != null ? `${kind} ${flux.toFixed(1)} ± ${err.toFixed(1)} µJy` : null,
    snr != null ? `S/N ${snr.toFixed(1)}` : null,
    ...measurementNotes(m),
  ].filter(Boolean).join(' · ')
}

function Details({ followup }: { followup: Followup }) {
  const shown = shownHypothesis(followup)
  const chart = snrPoints(followup).length >= 2
  const where = shown?.distance_au == null ? 'Along the straight line' : `At ${num(shown.distance_au, 2)} AU`
  return (
    <details className="disclosure">
      <summary>{chart ? 'S/N per distance, visits and checks' : 'Visits and checks'}</summary>
      <div className="followup-details">
        {chart && <FollowupChart followup={followup} />}
        {shown && shown.measurements.length > 0 && (
          <>
            <p className="followup-subhead">
              {where}, D{followup.detector}: {shown.visits} of {visitsText(shown.measurements.length)} usable
            </p>
            <ol className="track-check-rows">
              {shown.measurements.map((m) => (
                <li key={m.obs_id}>
                  <span>{measurementText(m, followup.psf_photometry)}</span>
                  <a href={m.source_url} target="_blank" rel="noopener noreferrer">
                    {m.obs_id}<span aria-hidden="true"> ↗</span><span className="sr-only"> (cutout, opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ol>
          </>
        )}
        {followup.checks.length > 0 && <ul className="followup-checks">
          {checkLines(followup.checks).map(({ code, severity, message, count, detail }) => (
            <li key={code}>
              <span aria-hidden="true">{SEVERITY[severity].icon}</span>
              <span>
                <span className="sr-only">{SEVERITY[severity].word}: </span>{message}{count > 1 && ` (${count}×)`}
                {detail && <span className="candidate-hint"> – {detail}</span>}
              </span>
            </li>
          ))}
        </ul>}
      </div>
    </details>
  )
}

// After the track checks: the button, then progress, then the result line first and every detail folded.
export function FollowupCheck({ state, observations }: { state: FollowupState; observations: Observation[] | null }) {
  const { kind, phase, job, followup, error } = state
  if (!kind) return null
  const start = () => state.start(observations)
  if (phase === 'idle') {
    const ready = state.ready(observations)
    return (
      <div className="followup">
        <button type="button" onClick={start} disabled={!ready}>{START}</button>
        <p className="candidate-hint">{ready ? HINT : NEEDS_VISITS}</p>
      </div>
    )
  }
  if (phase === 'sending' || phase === 'running') return <p className="candidate-hint" role="status">{progressText(job)}</p>
  if (phase === 'error' || !followup) {
    return (
      <p className="notice error" role="alert">
        Follow-up unavailable: {error} <button type="button" onClick={start}>Retry</button>
      </p>
    )
  }
  return (
    <div className="followup">
      <p className="track-check-summary">{followupResultText(followupResult(followup))}</p>
      {!followup.complete && (
        <p className="notice">
          Incomplete: the archive did not answer every request. <button type="button" onClick={start}>Retry</button>
        </p>
      )}
      <Details followup={followup} />
    </div>
  )
}
