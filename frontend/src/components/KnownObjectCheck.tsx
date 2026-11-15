import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CANDIDATE_STATES, MARK_LETTERS, VERDICTS, candidateState, type Evidence, type Mark, type Verdict } from '../candidate'
import { crossCheckLinks } from '../dataLinks'
import {
  NOT_LISTED, SBIDENT_NOT_LISTED, bodyText, checkMarks, followsTarget, matchBodies, matchRadius, sameCatalogueSource,
  sbidentMatches,
  type SkybotAnswer,
} from '../knownObjects'
import { MATCH_STYLE } from '../sourceLayer'
import type { ProperMotion, SmallBodyEpoch } from '../types'
import { ExternalLink } from './DataLinks'

export interface KnownContext {
  epochs: SmallBodyEpoch[]
  motion: ProperMotion | null
  detector: number
  target: string
}

// Mounted per set of marks (keyed by the caller): new marks start without answers or verdict.
export function KnownObjectCheck({ marks, epochs, motion, detector, target, evidence, children, initial = [], verdict: chosen, onVerdict }: KnownContext & {
  marks: Mark[]
  // Motion evidence from the possible track; shown right under the state chip.
  evidence?: Evidence
  children?: ReactNode
  initial?: SkybotAnswer[]
  // The user's verdict, when the caller keeps it (it goes into the marks file); otherwise kept here.
  verdict?: Verdict
  onVerdict?: (verdict: Verdict) => void
}) {
  const [answers, setAnswers] = useState<SkybotAnswer[]>(initial)
  const [running, setRunning] = useState(false)
  const [ownVerdict, setOwnVerdict] = useState<Verdict>(VERDICTS[0])
  const verdict = chosen ?? ownVerdict
  const setVerdict = (v: Verdict) => {
    setOwnVerdict(v)
    onVerdict?.(v)
  }
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const check = async () => {
    if (controller.current) return
    const own = new AbortController()
    controller.current = own
    setRunning(true)
    setAnswers([])
    await checkMarks(marks, own.signal, (answer) => setAnswers((old) => [...old, answer]))
    if (own.signal.aborted) return
    controller.current = null
    setRunning(false)
  }

  const perMark = marks.map((mark, i) => {
    const answer = answers[i]
    const skybot = answer && 'bodies' in answer ? matchBodies(answer.bodies, mark.sigma_arcsec) : null
    return { mark, answer, skybot, sbident: sbidentMatches(epochs, mark) }
  })
  const follows = followsTarget(motion, marks)
  const state = CANDIDATE_STATES[candidateState({
    ...evidence,
    knownBody: perMark.some((m) => (m.skybot?.possible.length ?? 0) > 0 || (m.sbident?.length ?? 0) > 0),
    catalogueStar: follows || sameCatalogueSource(marks),
  })]

  return (
    <div className="known-check">
      <p className="candidate-state">
        <span aria-hidden="true">{state.icon}</span> {state.word}
      </p>
      {children}
      <button type="button" onClick={() => void check()} disabled={running}>Check known objects</button>
      {(running || answers.length > 0) && (
        <p className="candidate-hint" role="status">SkyBoT: {answers.length} of {marks.length} checked</p>
      )}
      <ul className="known-evidence">
        {perMark.map(({ mark, answer, skybot, sbident }, i) => (
          <li key={mark.obs_id}>
            <strong>{MARK_LETTERS[i]}</strong> · within {matchRadius(mark.sigma_arcsec).toFixed(0)}″ at {mark.date.slice(0, 16).replace('T', ' ')} UTC
            <ul>
              {answer && 'error' in answer && <li className="known-error">{answer.error}</li>}
              {skybot && skybot.possible.length + skybot.nearby.length === 0 && <li>{NOT_LISTED}</li>}
              {skybot?.possible.map((b) => <li key={b.name}>◇ possible known Solar System body: {bodyText(b)} (SkyBoT)</li>)}
              {skybot?.nearby.map((b) => (
                <li key={b.name}>nearby: {bodyText(b)} (SkyBoT) – geocentric position, SPHEREx sees from low Earth orbit</li>
              ))}
              {sbident?.map((b) => <li key={b.name}>◇ possible known Solar System body: {bodyText(b)} (JPL SBIdent)</li>)}
              {sbident?.length === 0 && <li>{SBIDENT_NOT_LISTED}</li>}
              {mark.source && (mark.source.match === 'gaia' || mark.source.match === 'allwise') && (
                <li>
                  {MATCH_STYLE[mark.source.match].glyph} position coincides with {mark.source.match === 'gaia' ? 'Gaia DR3' : 'AllWISE'}{' '}
                  {mark.source.catalog_id} ({mark.source.separation_arcsec?.toFixed(1)}″) – a positional coincidence, not an identification
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      {follows && motion && (
        <p>Your marks follow {target} (Gaia DR3 {motion.source_id}): a known star moving as Gaia predicts</p>
      )}
      <ul className="data-links-list">
        {crossCheckLinks({ ra: marks[0].ra, dec: marks[0].dec, detector }).map((link) => (
          <li key={link.url}><ExternalLink link={link} /></li>
        ))}
      </ul>
      <p className="candidate-hint">Links at mark A. SIMBAD and VizieR list J2000 positions; a fast-moving star can sit far away.</p>
      <fieldset className="verdict">
        <legend>Your assessment</legend>
        {VERDICTS.map((v) => (
          <label key={v}>
            <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} /> {v}
          </label>
        ))}
      </fieldset>
      <p className="candidate-state">Your verdict: {verdict}</p>
      <p className="candidate-hint">Known objects: SkyBoT, IMCCE / Observatoire de Paris; NASA/JPL SBIdent.</p>
    </div>
  )
}
