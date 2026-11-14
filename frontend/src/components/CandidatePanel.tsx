import { MARK_LETTERS, markText, type Candidate } from '../candidate'
import { trackEvidence, type FrameCheck, type PossibleTrack, type Prediction } from '../track'
import { followsTarget } from '../knownObjects'
import type { Observation } from '../types'
import { CheckStep, pending, type StepStatus } from './CheckStep'
import { KnownObjectCheck, type KnownContext } from './KnownObjectCheck'
import { Precovery } from './Precovery'
import { TrackCheck, lookBackLine } from './TrackCheck'
import { TrackSummary, trackLine } from './TrackSummary'

interface Props {
  candidate: Pick<Candidate, 'marks' | 'notice' | 'armed' | 'setArmed' | 'clear'>
  // Why marking on the sky is off right now; null when it is possible.
  blocked: string | null
  track: PossibleTrack | null
  known: KnownContext
  // Every other loaded frame at the predicted position; null when no frame date has a prediction.
  lookBack?: { checks: FrameCheck[]; onShow: (index: number, prediction: Prediction) => void } | null
  // Every SPHEREx visit of the field and the obs_ids in the blink (stack members included); null until the archive answered.
  visits?: { observations: Observation[]; inBlink: string[] } | null
}

const NEEDS_MARKS = 'Mark the object in two frames with different dates first.'

/** States of steps 1–4; steps 5 and 6 live with their answers in KnownObjectCheck. */
export function stepStatuses(marks: number, track: PossibleTrack | null, lookBack: boolean, visits: boolean): StepStatus[] {
  const mark: StepStatus = { kind: marks === 0 ? 'todo' : marks === 1 ? 'active' : 'done' }
  if (marks < 2) return [mark, { kind: 'todo' }, { kind: 'todo' }, { kind: 'todo' }]
  const noTrack: StepStatus = { kind: 'blocked', reason: 'needs a possible track' }
  if (!track) return [mark, { kind: 'blocked', reason: 'these marks give no fit' }, noTrack, noTrack]
  const look: StepStatus = track.regime === 'none' ? { kind: 'blocked', reason: 'no significant motion' }
    : track.regime === 'solarSystem' ? { kind: 'blocked', reason: 'no straight-line prediction across epochs' }
    // A stellar or fast track predicts at least the marked frames' dates; none means the difference view is shown.
    : !lookBack ? { kind: 'blocked', reason: 'switch from Difference to single frames' }
    : { kind: 'done' }
  return [mark, { kind: 'done' }, look, { kind: visits ? 'done' : 'active' }]
}

// The candidate check as six steps: only the current one is open, the others show one summary line.
export function CandidatePanel({ candidate: { marks, notice, armed, setArmed, clear }, blocked, track, known, lookBack, visits }: Props) {
  const steps = stepStatuses(marks.length, track, lookBack != null, visits != null)
  const first = steps.findIndex(pending)
  const firstPending = first < 0 ? null : first + 1
  const blockedHint = (status: StepStatus) => status.kind === 'blocked' && <p className="candidate-hint">Not possible: {status.reason}.</p>
  const markStep = (
    <CheckStep n={1} status={steps[0]} current={firstPending === 1}
      summary={marks.length ? marks.map((m, i) => `${MARK_LETTERS[i]} ${m.date.slice(0, 16).replace('T', ' ')}`).join(' · ') + ' UTC' : undefined}>
      {marks.length < 2 && (
        <p className="candidate-next">
          {marks.length === 0 ? 'Spotted motion? Mark the object in two frames' : 'Now mark it in another frame'}
        </p>
      )}
      <button type="button" aria-pressed={armed} disabled={blocked != null} onClick={() => setArmed(!armed)}>
        <span aria-hidden="true">◎</span> Mark in this frame
      </button>
      <p className="candidate-hint">
        {blocked ?? (armed
          ? 'Click the object inside the SPHEREx frame on the sky. "Mark" in Detected sources works too.'
          : 'Or use "Mark" next to a detected source.')}
      </p>
      {marks.length > 0 && (
        <ol className="candidate-marks">
          {marks.map((mark, i) => (
            <li key={mark.obs_id}>
              <span className="candidate-glyph" aria-hidden="true">◎</span> {markText(mark, MARK_LETTERS[i])}
            </li>
          ))}
        </ol>
      )}
    </CheckStep>
  )
  const onDetector = visits?.observations.filter((o) => o.detector === known.detector).length ?? 0
  return (
    <section className="candidate-check" aria-labelledby="candidate-heading">
      <h3 id="candidate-heading" className="sr-only">Candidate check</h3>
      <p className="candidate-notice" role="status" aria-live="polite">{notice}</p>
      {marks.length === 0
        ? (
          <ol className="check-steps">
            {markStep}
            {[2, 3, 4, 5, 6].map((n) => (
              <CheckStep key={n} n={n} status={{ kind: 'todo' }} current={false}><p className="candidate-hint">{NEEDS_MARKS}</p></CheckStep>
            ))}
          </ol>
        )
        : (
          <KnownObjectCheck key={marks.map((m) => `${m.obs_id}:${m.ra}:${m.dec}`).join()} marks={marks} {...known}
            evidence={trackEvidence(track)} firstPending={firstPending}>
            {markStep}
            <CheckStep n={2} status={steps[1]} current={firstPending === 2} summary={track ? trackLine(track) : undefined}>
              {track ? <TrackSummary track={track} /> : blockedHint(steps[1]) || <p className="candidate-hint">{NEEDS_MARKS}</p>}
            </CheckStep>
            <CheckStep n={3} status={steps[2]} current={firstPending === 3} summary={lookBack ? lookBackLine(lookBack.checks) : undefined}>
              {lookBack && steps[2].kind === 'done'
                ? <TrackCheck checks={lookBack.checks} onShow={lookBack.onShow} />
                : blockedHint(steps[2]) || <p className="candidate-hint">{NEEDS_MARKS}</p>}
            </CheckStep>
            <CheckStep n={4} status={steps[3]} current={firstPending === 4}
              summary={visits ? `${onDetector} SPHEREx ${onDetector === 1 ? 'visit' : 'visits'} on D${known.detector} to check` : undefined}>
              {visits
                ? <Precovery track={track} marks={marks} {...visits} detector={known.detector}
                  followsTarget={followsTarget(known.motion, marks) ? known.target : null} />
                : <p className="candidate-hint">{track ? 'Waiting for the archive’s list of visits.' : NEEDS_MARKS}</p>}
            </CheckStep>
          </KnownObjectCheck>
        )}
      {marks.length > 0 && <button type="button" onClick={clear}>Clear marks</button>}
    </section>
  )
}
