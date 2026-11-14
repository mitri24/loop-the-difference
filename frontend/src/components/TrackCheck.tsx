import { utcMinute } from '../blink'
import { MATCH_STYLE, degText } from '../sourceLayer'
import { SPHEREX_SOURCE_CAP, type FrameCheck, type LookBack, type Prediction } from '../track'

const RESULT_TEXT: Record<Exclude<LookBack['kind'], 'detection' | 'nothing'>, string> = {
  outside: 'outside this frame',
  window: 'outside the straight-line window (see distance hypotheses)',
  noSources: 'no source list – reload this comparison',
}

function resultText({ frame, result, radius_arcsec }: FrameCheck): string {
  if (result.kind === 'detection') {
    const style = MATCH_STYLE[result.source.match]
    return `◎ detection ${result.sep_arcsec.toFixed(1)}″ from the prediction (S/N ${result.source.snr.toFixed(0)}, ${style.glyph} ${style.word})`
  }
  if (result.kind === 'nothing') {
    const notes = [
      frame.coverage < 1 && 'frame only partly covered',
      (frame.sources?.length ?? 0) >= SPHEREX_SOURCE_CAP && `source list holds only the ${SPHEREX_SOURCE_CAP} brightest`,
    ].filter(Boolean)
    return `– nothing ≥5σ within ${radius_arcsec.toFixed(1)}″${notes.map((n) => ` (${n})`).join('')}`
  }
  return RESULT_TEXT[result.kind]
}

export function lookBackLine(checks: FrameCheck[]): string {
  const checked = checks.filter((c) => c.result.kind === 'detection' || c.result.kind === 'nothing')
  const consistent = checked.filter((c) => c.result.kind === 'detection').length
  return `Consistent with the possible track in ${consistent} of ${checked.length} other frames`
}

// Look back within SPHEREx: every other loaded frame at the possible track's predicted position.
export function TrackCheck({ checks, onShow }: { checks: FrameCheck[]; onShow: (index: number, prediction: Prediction) => void }) {
  return (
    <div className="track-check">
      <p className="track-check-summary">{lookBackLine(checks)}</p>
      <ol className="track-check-rows">
        {checks.map((check) => (
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
