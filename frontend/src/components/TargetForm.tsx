import { useState } from 'react'
import { CHALLENGE_TARGETS, DETECTORS, FIELDS_OF_VIEW } from '../targets'
import type { TargetQuery } from '../url'

interface Props {
  value: TargetQuery
  busy: boolean
  onShow: (query: TargetQuery) => void
  onFind: (name: string, base: TargetQuery) => void
}

export function TargetForm({ value, busy, onShow, onFind }: Props) {
  const [draft, setDraft] = useState(value)
  const [name, setName] = useState('')

  return (
    <form
      className="target-form"
      onSubmit={(event) => {
        event.preventDefault()
        onShow(draft)
      }}
    >
      <label>
        Right ascension
        <input
          value={draft.ra}
          onChange={(event) => setDraft({ ...draft, ra: event.target.value })}
          placeholder="08h55m10.8s or 133.795"
          required
        />
      </label>
      <label>
        Declination
        <input
          value={draft.dec}
          onChange={(event) => setDraft({ ...draft, dec: event.target.value })}
          placeholder="-7d14m42.5s or -7.245"
          required
        />
      </label>
      <div className="form-row">
        <label>
          Field of view
          <select
            value={draft.fov}
            onChange={(event) => setDraft({ ...draft, fov: Number(event.target.value) })}
          >
            {FIELDS_OF_VIEW.map((fov) => (
              <option key={fov} value={fov}>
                {fov}° ({Math.round(fov * 60)}′)
              </option>
            ))}
          </select>
        </label>
        <label>
          Detector
          <select
            value={draft.band}
            onChange={(event) => setDraft({ ...draft, band: Number(event.target.value) })}
          >
            {DETECTORS.map((detector) => (
              <option key={detector.band} value={detector.band}>
                {detector.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" className="primary" disabled={busy}>
        Show changes over time
      </button>

      <div className="lookup">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Object name, e.g. R Dra"
          aria-label="Object name"
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => onFind(name.trim(), draft)}
        >
          Find
        </button>
      </div>

      <p className="label">Challenge targets</p>
      <div className="chips">
        {CHALLENGE_TARGETS.map((target) => (
          <button
            type="button"
            key={target.label}
            disabled={busy}
            onClick={() =>
              'name' in target
                ? onFind(target.name, draft)
                : onShow({ ...draft, ra: target.ra, dec: target.dec })
            }
          >
            {target.label}
          </button>
        ))}
      </div>
    </form>
  )
}
