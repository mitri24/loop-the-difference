import { utcMinute } from '../blink'
import {
  MAX_AU, MAX_TARGETS, MIN_AU, TRACK_WINDOW_DAYS, distanceRanges, outsideRanges,
  type DistantRow, type DistantSummary, type DistantTrackState, type Nearest,
} from '../distantTrack'
import { MATCH_STYLE, degText } from '../sourceLayer'
import { FIELDS_OF_VIEW } from '../targets'
import { SPHEREX_SOURCE_CAP, num, type FrameCheck, type LookBack, type Prediction } from '../track'
import type { Frame } from '../types'

// Frames beyond the straight-line window belong to the distant-object track below, not to this list.
type LineCheck = FrameCheck & { result: Extract<LookBack, { kind: 'detection' }> | { kind: 'nothing' | 'outside' | 'noSources' } }

const NO_SOURCES = 'no source list – reload this comparison'
const RESULT_TEXT: Record<'outside' | 'noSources', string> = {
  outside: 'outside this frame',
  noSources: NO_SOURCES,
}

// Why "nothing" may still hide the object.
const nothingNotes = (frame: Frame) => [
  frame.coverage < 1 && 'frame only partly covered',
  (frame.sources?.length ?? 0) >= SPHEREX_SOURCE_CAP && `source list holds only the ${SPHEREX_SOURCE_CAP} brightest`,
].filter(Boolean).map((note) => ` (${note})`).join('')

function resultText({ frame, result, radius_arcsec }: LineCheck): string {
  if (result.kind === 'detection') {
    const style = MATCH_STYLE[result.source.match]
    return `◎ detection ${result.sep_arcsec.toFixed(1)}″ from the prediction (S/N ${result.source.snr.toFixed(0)}, ${style.glyph} ${style.word})`
  }
  if (result.kind === 'nothing') return `– nothing ≥5σ within ${radius_arcsec.toFixed(1)}″${nothingNotes(frame)}`
  return RESULT_TEXT[result.kind]
}

// Look back within SPHEREx: every other loaded frame where the straight line holds, at the possible track's predicted position.
export function TrackCheck({ checks, onShow }: { checks: FrameCheck[]; onShow: (index: number, prediction: Prediction) => void }) {
  const rows = checks.filter((c): c is LineCheck => c.result.kind !== 'window')
  if (rows.length === 0) return null
  const checked = rows.filter((c) => c.result.kind === 'detection' || c.result.kind === 'nothing')
  const consistent = checked.filter((c) => c.result.kind === 'detection').length
  return (
    <div className="track-check">
      <p className="track-check-summary">
        Consistent with the possible track in {consistent} of {checked.length} other frames
      </p>
      <ol className="track-check-rows">
        {rows.map((check) => (
          <li key={check.frame.obs_id}>
            <span>
              {utcMinute(check.frame.date)}
              {check.prediction && ` · RA ${degText(check.prediction.ra)} Dec ${degText(check.prediction.dec)} · r ${check.radius_arcsec.toFixed(1)}″`}
              {' · '}{resultText(check)}
            </span>
            {check.prediction && (
              <button type="button" onClick={() => onShow(check.index, check.prediction!)}>Show on the sky</button>
            )}
          </li>
        ))}
      </ol>
      <p className="candidate-hint">A detection near a prediction can be another source; nothing ≥5σ can mean too faint.</p>
    </div>
  )
}

const DISTANT = 'Distant-object track'
const COUNTED = 'Counted: detections ≥5σ with no Gaia DR3 or AllWISE match, or with no catalogue answer, inside a search circle (2σ plus the model error, at least 1.5 pixels). One can still be another source; nothing can mean too faint.'
// Positions this close to the centre fit into the largest region size on offer.
const REACH_DEG = Math.max(...FIELDS_OF_VIEW) / 2

const imagesText = (n: number) => `${n} other ${n === 1 ? 'image' : 'images'}`
const rangesText = (ranges: [number, number][], joiner: string) => `${ranges
  .map(([near, far]) => (num(near, 2) === num(far, 2) ? num(near, 2) : `${num(near, 2)}–${num(far, 2)}`)).join(joiner)} AU`
const sepText = (arcsec: number) => (arcsec < 60 ? `${arcsec.toFixed(1)}″` : `${(arcsec / 60).toFixed(1)}′`)
const offsetText = (deg: number) => `nearest ${deg < 1 ? deg.toFixed(2) : deg.toFixed(1)}° from its centre`
const outsideText = (outside: number) => (outside > 0 ? ` · outside the field in ${outside} more` : '')

export function distantSummaryText(summary: DistantSummary): string {
  switch (summary.kind) {
    case 'fits':
      return `${DISTANT}: fits ${rangesText(summary.ranges, ' or ')} in ${summary.images} of ${imagesText(summary.checked)}`
        + `${summary.unknownOnly ? ' (catalogue unavailable for these detections)' : ''}${outsideText(summary.outside)}`
    case 'nothing':
      return `${DISTANT}: no uncatalogued detection on the possible positions inside the field in ${imagesText(summary.checked)}${outsideText(summary.outside)}`
    case 'outside':
      return `${DISTANT}: possible positions leave this field (${offsetText(summary.offset_deg)})${summary.offset_deg < REACH_DEG ? ' – choose a larger region size' : ''}`
    case 'unchecked':
      return `${DISTANT}: no other image can be checked`
  }
}

const nearestText = ({ sep_arcsec, source }: Nearest) => {
  const style = MATCH_STYLE[source.match]
  return `nearest detection ${sepText(sep_arcsec)} (S/N ${source.snr.toFixed(0)}, ${style.glyph} ${style.word})`
}

function distantRowText({ frame, result }: DistantRow, distances: number[]): string {
  switch (result.kind) {
    case 'fits':
    case 'nothing': {
      const found = result.kind === 'fits'
        ? `${rangesText(distanceRanges(result.hits, distances), ', ')} · ${nearestText(result.nearest)}`
        : `none · ${result.nearest ? nearestText(result.nearest) : 'no uncatalogued detection in this frame'}${nothingNotes(frame)}`
      const missing = outsideRanges(result.inside, distances)
      return missing.length > 0 ? `${found} · ${rangesText(missing, ', ')} outside the field` : found
    }
    case 'outside':
      return `positions outside the field (${offsetText(result.offset_deg)})`
    case 'noSources':
      return NO_SOURCES
    case 'tooFar':
      return `more than ${TRACK_WINDOW_DAYS} days from the marks – not predicted`
    case 'overLimit':
      return `beyond the ${MAX_TARGETS} times nearest to the marks – not predicted`
  }
}

// Images beyond the straight-line window: the result first, every image and the model on demand.
export function DistantTrackCheck({ state }: { state: DistantTrackState }) {
  const { status, range, track, rows, summary } = state
  if (status === 'off') return null
  if (status === 'tooFast') return <p className="candidate-hint">{DISTANT}: moves too fast for an object beyond {MIN_AU} AU</p>
  if (status === 'marksTooClose') return <p className="candidate-hint">{DISTANT}: needs marks more than 86 s apart</p>
  if (status === 'marksTooFar') return <p className="candidate-hint">{DISTANT}: needs marks at most {TRACK_WINDOW_DAYS} days apart</p>
  if (status === 'loading') {
    return <p className="candidate-hint" role="status">{DISTANT}: computing positions{range && ` for ${rangesText([range], '')}`}…</p>
  }
  if (status === 'error') {
    return (
      <p className="notice error" role="alert">
        {DISTANT} unavailable: {state.error} <button type="button" onClick={state.retry}>Retry</button>
      </p>
    )
  }
  const distances = track?.hypotheses.map((h) => h.distance_au) ?? []
  const farthest = distances.at(-1)
  return (
    <div className="track-check">
      {summary && <p className="track-check-summary">{distantSummaryText(summary)}</p>}
      <details className="disclosure">
        <summary>Per image and model</summary>
        <ol className="track-check-rows">
          {rows.map((row) => (
            <li key={row.frame.obs_id}><span>{utcMinute(row.frame.date)} · {distantRowText(row, distances)}</span></li>
          ))}
        </ol>
        <p className="candidate-hint">{COUNTED}</p>
        {track && farthest != null && (
          <p className="candidate-hint">
            {track.model} · {distances.length} assumed distances, {rangesText([[distances[0], farthest]], '')}, uniform in 1/d.
            {farthest < MAX_AU && ` Beyond ${num(farthest, 2)} AU no bound object moves as fast as the marks.`} {track.assumptions.join(' ')}
          </p>
        )}
      </details>
    </div>
  )
}
