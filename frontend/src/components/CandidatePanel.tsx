import type { ReactNode } from 'react'
import { MARK_LETTERS, markText, type Candidate } from '../candidate'
import type { DistantTrackState } from '../distantTrack'
import type { FollowupState } from '../followup'
import { trackEvidence, type PossibleTrack } from '../track'
import { followsTarget } from '../knownObjects'
import type { Observation } from '../types'
import { KnownObjectCheck, type KnownContext } from './KnownObjectCheck'
import { Precovery } from './Precovery'
import { FollowupCheck } from './FollowupCheck'
import { DistantTrackCheck } from './TrackCheck'
import { TrackSummary } from './TrackSummary'

interface Props {
  candidate: Pick<Candidate, 'marks' | 'notice' | 'armed' | 'setArmed' | 'clear'> & Partial<Pick<Candidate, 'verdict' | 'setVerdict' | 'objects' | 'activeObject' | 'selectObject' | 'newObject' | 'renameObject'>>
  // Why marking on the sky is off right now; null when it is possible.
  blocked: string | null
  track: PossibleTrack | null
  known: KnownContext
  children?: ReactNode
  // Detected sources with their "Mark" buttons are listed (not without the sky view).
  sources?: boolean
  // Every SPHEREx visit of the field and the obs_ids in the blink (stack members included); null until the archive answered.
  visits?: { observations: Observation[]; inBlink: string[] } | null
  // Positions for assumed distances in the images beyond the straight-line window (useDistantTrack).
  distant?: DistantTrackState
  // Forced photometry along the track at every other visit, started on request (useFollowup).
  followup?: FollowupState
}

// Beside the image: what to do next, the marks so far and what they still need.
export function CandidatePanel({ candidate: { marks, notice, armed, setArmed, clear, verdict, setVerdict, objects, activeObject, selectObject, newObject, renameObject }, blocked, track, known, visits, distant, followup, sources = true, children }: Props) {
  return (
    <section className="candidate-check" aria-labelledby="candidate-heading">
      <h3 id="candidate-heading">3 · Your objects</h3>
      {objects && <div className="object-chooser" role="group" aria-label="Marked objects">
        {objects.map((object) => <button key={object.index} type="button" aria-pressed={activeObject === object.index}
          onClick={() => selectObject?.(object.index)}>{object.name || `Object ${object.index + 1}`} · {object.count}/2</button>)}
        <button type="button" onClick={newObject}>+ Add object</button>
      </div>}
      {objects && renameObject && <label className="object-name">Object name
        <input type="text" maxLength={80} value={objects.find((object) => object.index === activeObject)?.name ?? ''}
          placeholder={`Object ${(activeObject ?? 0) + 1}`} onChange={(event) => renameObject(event.target.value)} />
      </label>}
      <p className="candidate-hint">One object at a time: mark it in two images. Add another object to keep a separate pair.</p>
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
            {distant && <DistantTrackCheck state={distant} />}
            {followup && <FollowupCheck state={followup} observations={visits?.observations ?? null} />}
          </KnownObjectCheck>
          {visits && <Precovery track={track} marks={marks} {...visits} detector={known.detector}
            followsTarget={followsTarget(known.motion, marks) ? known.target : null} />}
          <p className="candidate-hint">Share in the top bar copies a link with your markers included; anyone opening it sees the same comparison and marked positions. Export in the top bar saves all data as a file.</p>
          <div className="candidate-actions">
            <button type="button" onClick={clear}>Clear this object’s marks</button>
          </div>
        </>
      )}
    </section>
  )
}
