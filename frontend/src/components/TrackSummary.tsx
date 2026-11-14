import { DAYS_PER_YEAR, REGIMES, SEARCH_AREA_LABEL, type PossibleTrack } from '../track'

const num = (value: number, digits = 3) => Number(value.toPrecision(digits)).toString()

// The collapsed step line, e.g. "Track: 0.21″/h ± 0.03, PA 172°".
export const trackLine = ({ fit, regime }: PossibleTrack) => regime === 'none'
  ? `Track: ${REGIMES.none.word.toLowerCase()}`
  : `Track: ${num(fit.rate / 24)}″/h ± ${num(fit.sigmaRate / 24, 2)}, PA ${fit.pa.toFixed(0)}°`

// What the marks say about motion: rate ± 1σ, direction and whether a straight line is valid.
export function TrackSummary({ track: { fit, regime, predictions } }: { track: PossibleTrack }) {
  const kind = REGIMES[regime]
  return (
    <div className="track-summary">
      <p className="track-regime">
        <span aria-hidden="true">{kind.icon}</span> {kind.word}
      </p>
      <p className="track-numbers">
        {num(fit.rate / 24)} ± {num(fit.sigmaRate / 24, 2)}″/h · {num(fit.rate * DAYS_PER_YEAR)} ± {num(fit.sigmaRate * DAYS_PER_YEAR, 2)}″/yr ·
        PA {fit.pa.toFixed(0)}° · {fit.n} marks{fit.rmsArcsec != null && ` · residual rms ${fit.rmsArcsec.toFixed(1)}″`}
      </p>
      <p className="candidate-hint">
        {kind.note}{predictions.length > 0 && ` Dashed circles: search area, ${SEARCH_AREA_LABEL}.`}
      </p>
    </div>
  )
}
