import { CHALLENGE_TARGETS, DETECTORS, FIELDS_OF_VIEW } from '../targets'
import type { TargetQuery } from '../url'

interface Props {
  value: TargetQuery
  busy: boolean
  onShow: (query: TargetQuery) => void
  onFind: (name: string, base: TargetQuery) => void
  onChange: (query: TargetQuery) => void
}

export function TargetForm({ value: draft, busy, onShow, onFind, onChange: setDraft }: Props) {

  return (
    <form id="region-form" className="target-form" onSubmit={(event) => { event.preventDefault(); onShow(draft) }}>
      <fieldset className="preset-group">
        <legend>Explore a target</legend>
        <p className="muted">Coverage is checked when you select a target.</p>
        <div className="target-presets">
          {CHALLENGE_TARGETS.map((target) => (
            <button type="button" key={target.label} disabled={busy}
              onClick={() => 'name' in target ? onFind(target.name, draft)
                : onShow({ ...draft, ra: target.ra, dec: target.dec })}>
              <span>{target.label}</span><span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </fieldset>
      <details className="coordinate-disclosure">
        <summary>Enter precise coordinates</summary>
        <fieldset className="coordinate-group">
        <legend>Or enter a sky position</legend>
        <label>Right ascension <span className="field-hint">Degrees or h:m:s</span>
          <input value={draft.ra} onChange={(event) => setDraft({ ...draft, ra: event.target.value })}
            placeholder="02:31:49.09" required />
        </label>
        <label>Declination <span className="field-hint">Degrees or ±d:m:s</span>
          <input value={draft.dec} onChange={(event) => setDraft({ ...draft, dec: event.target.value })}
            placeholder="+89:15:50.8" required />
        </label>
        </fieldset>
      </details>
      <div className="form-row">
        <label>Region size
          <select value={draft.fov} onChange={(event) => setDraft({ ...draft, fov: Number(event.target.value) })}>
            {[...new Set([...FIELDS_OF_VIEW, draft.fov])].sort((a, b) => a - b).map((fov) => (
              <option key={fov} value={fov}>{fov}° ({Math.round(fov * 60)}′)</option>
            ))}
          </select>
        </label>
        <label>Observation detector
          <select value={draft.band} onChange={(event) => setDraft({ ...draft, band: Number(event.target.value) })}>
            {DETECTORS.map((detector) => <option key={detector.band} value={detector.band}>{detector.label}</option>)}
          </select>
        </label>
      </div>
    </form>
  )
}
