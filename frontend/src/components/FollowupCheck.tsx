import {
  followupResult, followupResultText, measurementText, NEEDS_VISITS, progressText, shownHypothesis, visitsText, type FollowupState,
} from '../followup'
import { num } from '../track'
import type { Followup, Observation } from '../types'
import '../styles/followup.css'
import { CheckList } from './CheckList'
import { FingerprintCheck } from './FingerprintCheck'
import { FollowupChart, snrPoints } from './FollowupChart'

export const START = 'Check all SPHEREx visits'
const HINT = {
  distances: 'Measures the flux where the track puts the object in this detector’s other visits within 400 days of the marks and stacks it. Loads up to 48 IRSA cutouts; takes minutes.',
  line: 'Measures the flux along the straight line in this detector’s other visits and stacks it. Loads up to 48 IRSA cutouts; takes minutes.',
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
        <CheckList checks={followup.checks} />
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
        <p className="candidate-hint">{ready ? HINT[kind] : NEEDS_VISITS}</p>
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
  const result = followupResult(followup)
  return (
    <div className="followup">
      <p className="track-check-summary">{followupResultText(result)}</p>
      {!followup.complete && (
        <p className="notice">
          Incomplete: the archive did not answer every request. <button type="button" onClick={start}>Retry</button>
        </p>
      )}
      <Details followup={followup} />
      {/* A signal is worth a spectrum: the same track in the visits of every detector. New result, new fingerprint. */}
      {result.kind === 'signal' && <FingerprintCheck key={job?.job_id} request={() => state.fingerprint(observations)} />}
    </div>
  )
}
