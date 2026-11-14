import { CANDIDATE_STATES, MARK_LETTERS, candidateState, markText, type Candidate } from '../candidate'
import { trackEvidence, type PossibleTrack } from '../track'
import { TrackSummary } from './TrackSummary'

interface Props {
  candidate: Pick<Candidate, 'marks' | 'notice' | 'armed' | 'setArmed' | 'clear'>
  // Why marking on the sky is off right now; null when it is possible.
  blocked: string | null
  track: PossibleTrack | null
}

// Directly under the blink: what to do next, the marks so far and what they still need.
export function CandidatePanel({ candidate: { marks, notice, armed, setArmed, clear }, blocked, track }: Props) {
  const state = CANDIDATE_STATES[candidateState(trackEvidence(track))]
  return (
    <section className="candidate-check" aria-labelledby="candidate-heading">
      <h3 id="candidate-heading">Candidate check</h3>
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
      <p className="candidate-notice" role="status" aria-live="polite">{notice}</p>
      {marks.length > 0 && (
        <>
          <ol className="candidate-marks">
            {marks.map((mark, i) => (
              <li key={mark.obs_id}>
                <span className="candidate-glyph" aria-hidden="true">◎</span> {markText(mark, MARK_LETTERS[i])}
              </li>
            ))}
          </ol>
          <p className="candidate-state">
            <span aria-hidden="true">{state.icon}</span> {state.word}
          </p>
          {track && <TrackSummary track={track} />}
          <button type="button" onClick={clear}>Clear marks</button>
        </>
      )}
    </section>
  )
}
