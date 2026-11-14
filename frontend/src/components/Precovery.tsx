import type { Mark } from '../candidate'
import { formatDeg } from '../dataLinks'
import { TRACK_LABEL } from '../motionTrack'
import { historicalRows, visitRows, type LookRow } from '../precovery'
import { SEARCH_AREA_LABEL, type PossibleTrack } from '../track'
import type { Observation } from '../types'
import { ExternalLink } from './DataLinks'

export const SHOWN_ROWS = 30

interface Props {
  track: PossibleTrack | null
  marks: Mark[]
  observations: Observation[]
  // obs_ids of the frames in the blink.
  inBlink: string[]
  detector: number
  // The named target, when the marks follow its Gaia DR3 motion.
  followsTarget: string | null
}

function Row({ row }: { row: LookRow }) {
  return (
    <li>
      <span>{row.when} · {row.source}{row.inBlink && ' · in the blink'}</span>
      {row.at && <span> · predicted RA {formatDeg(row.at.ra)}° Dec {formatDeg(row.at.dec)}° ± {row.at.radius_arcsec.toFixed(1)}″</span>}
      {row.note
        ? <span className="muted"> · {row.note}</span>
        : row.links.map((link) => (
          <span key={link.url}> · <ExternalLink link={link} /></span>
        ))}
    </li>
  )
}

// Where the possible track predicts the object at other SPHEREx visits and on older surveys, for the user to check.
export function Precovery({ track, marks, observations, inBlink, detector, followsTarget }: Props) {
  const visits = track ? visitRows(observations, detector, inBlink, track, marks) : []
  const older = track ? historicalRows(track, detector) : []
  return (
    <details className="disclosure precovery">
      <summary>Where to look in older observations</summary>
      {followsTarget && (
        <p className="candidate-hint">Your marks follow {followsTarget}: its path {TRACK_LABEL} is drawn on the sky.</p>
      )}
      {!track
        ? <p className="candidate-hint">Mark the object in two frames with different dates to get predicted positions.</p>
        : (
          <>
            <p className="candidate-hint">Predicted positions to check, search radius {SEARCH_AREA_LABEL}. Nothing is checked automatically.</p>
            {visits.length === 0
              ? <p className="candidate-hint">The archive lists no SPHEREx visit of this field on D{detector}.</p>
              : <h4>SPHEREx D{detector} · {visits.length} {visits.length === 1 ? 'visit' : 'visits'} of this field, newest first</h4>}
            {visits.length > 0 && <ol className="precovery-rows">{visits.slice(0, SHOWN_ROWS).map((row) => <Row key={row.key} row={row} />)}</ol>}
            {visits.length > SHOWN_ROWS && (
              <details>
                <summary>{visits.length - SHOWN_ROWS} older visits</summary>
                <ol className="precovery-rows" start={SHOWN_ROWS + 1}>
                  {visits.slice(SHOWN_ROWS).map((row) => <Row key={row.key} row={row} />)}
                </ol>
              </details>
            )}
            {older.length > 0 && (
              <>
                <h4>Older surveys</h4>
                <ul className="precovery-rows">{older.map((row) => <Row key={row.key} row={row} />)}</ul>
              </>
            )}
          </>
        )}
    </details>
  )
}
