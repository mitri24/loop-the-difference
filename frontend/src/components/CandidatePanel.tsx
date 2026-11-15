import type { ReactNode } from 'react'
import { MARK_LETTERS, markText, type Candidate } from '../candidate'
import { trackEvidence, type PossibleTrack } from '../track'
import { followsTarget } from '../knownObjects'
import type { Observation } from '../types'
import { KnownObjectCheck, type KnownContext } from './KnownObjectCheck'
import { Precovery } from './Precovery'
import { TrackSummary } from './TrackSummary'

interface Props {
  candidate: Pick<Candidate, 'marks' | 'notice' | 'armed' | 'setArmed' | 'clear'> & Partial<Pick<Candidate, 'verdict' | 'setVerdict'>>
  // Why marking on the sky is off right now; null when it is possible.
  blocked: string | null
  track: PossibleTrack | null
  known: KnownContext
  children?: ReactNode
  // Detected sources with their "Mark" buttons are listed (not without the sky view).
  sources?: boolean
  // Every SPHEREx visit of the field and the obs_ids in the blink (stack members included); null until the archive answered.
  visits?: { observations: Observation[]; inBlink: string[] } | null
  // Saves the marks with their frames, detections, track and verdict, and the link that opens them again.
  onDownload?: () => void
}

// Beside the image: what to do next, the marks so far and what they still need.
export function CandidatePanel({ candidate: { marks, notice, armed, setArmed, clear, verdict, setVerdict }, blocked, track, known, visits, sources = true, onDownload, children }: Props) {
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
          ? `Click the object in the image.${sources ? ' "Mark" in Detected sources works too.' : ''}`
          : sources && 'Or use "Mark" next to a detected source.')}
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
          <KnownObjectCheck key={marks.map((m) => `${m.obs_id}:${m.ra}:${m.dec}`).join()} marks={marks} {...known}
            evidence={trackEvidence(track)} verdict={verdict} onVerdict={setVerdict}>
            {track && <TrackSummary track={track} />}
            {children}
          </KnownObjectCheck>
          {visits && <Precovery track={track} marks={marks} {...visits} detector={known.detector}
            followsTarget={followsTarget(known.motion, marks) ? known.target : null} />}
          <div className="candidate-actions">
            {onDownload && <button type="button" onClick={onDownload} title="A JSON file with the marks, their frames and detections, the possible track, your verdict and a link that opens them here again">
              <span aria-hidden="true">↓</span> Download marks
            </button>}
            <button type="button" onClick={clear}>Clear marks</button>
          </div>
        </>
      )}
    </section>
  )
}
