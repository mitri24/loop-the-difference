import type { AladinInstance } from 'aladin-lite'
import { useState } from 'react'
import { type LayerKey, MAX_SOURCES, useCatalogLayers } from '../catalogLayers'

interface Props {
  aladin: AladinInstance | null
  ra: number
  dec: number
  sizeDeg: number
  frameMjd: number | null
}

const LABELS: Record<LayerKey, { name: string; shape: string; what: string }> = {
  gaia: { name: 'Gaia DR3', shape: '○', what: 'stars' },
  wise: { name: 'AllWISE', shape: '□', what: 'red sources' },
  simbad: { name: 'SIMBAD', shape: '△', what: 'objects' },
  skybot: { name: 'SkyBoT', shape: '◇', what: 'asteroids' },
}
const KEYS = Object.keys(LABELS) as LayerKey[]

// Catalogue overlays, all off by default: every marker is a known source, nothing more.
export function CatalogLegend({ aladin, ra, dec, sizeDeg, frameMjd }: Props) {
  const [enabled, setEnabled] = useState({ gaia: false, wise: false, simbad: false, skybot: false })
  const { status, skybotDate } = useCatalogLayers(aladin, enabled, sizeDeg, frameMjd)
  return (
    <div className="catalog-legend">
      {KEYS.map((key) => {
        const { name, shape, what } = LABELS[key]
        const failed = status[key] === 'unavailable'
        // Gaia and SkyBoT positions depend on the frame date, so they wait for frames.
        const needsFrame = (key === 'gaia' || key === 'skybot') && frameMjd == null
        return (
          <label key={key} className={failed ? 'unavailable' : undefined}>
            <input
              type="checkbox"
              checked={enabled[key]}
              disabled={!aladin || needsFrame}
              onChange={(event) => setEnabled((old) => ({ ...old, [key]: event.target.checked }))}
            />
            {failed ? (
              `${name} unavailable`
            ) : (
              <>
                {name} <span style={{ color: `var(--cat-${key})` }}>{shape}</span> {what}
                {key === 'skybot' && skybotDate && ` @ ${skybotDate}`}
                {status[key] === 'loading' && ' …'}
              </>
            )}
          </label>
        )
      })}
      <p className="hint">
        A blinking source without a marker needs verification — it is not a discovery. Each
        catalogue shows its {MAX_SOURCES} brightest sources at most.{' '}
        <a href={`http://byw.tools/wiseview#ra=${ra}&dec=${dec}`} target="_blank" rel="noreferrer">
          Check in WiseView
        </a>
      </p>
    </div>
  )
}
