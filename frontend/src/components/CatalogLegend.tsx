import type { AladinInstance } from 'aladin-lite'
import { type ReactNode, useEffect, useState } from 'react'
import { type LayerKey, MAX_SOURCES, NEAR_DEG, type SkyMark, useCatalogLayers } from '../catalogLayers'

interface Props {
  aladin: AladinInstance | null
  sizeDeg: number
  frameMjd: number | null
  // More layers of known sources, listed after SkyBoT.
  children?: ReactNode
  // The markers of the layers that are on, so the SPHEREx images show them too.
  onMarks?: (marks: Record<LayerKey, SkyMark[]>) => void
}

const LABELS: Record<LayerKey, { name: string; shape: string; what: string }> = {
  gaia: { name: 'Gaia DR3', shape: '○', what: 'stars' },
  wise: { name: 'AllWISE', shape: '□', what: 'red sources' },
  simbad: { name: 'SIMBAD', shape: '△', what: 'objects' },
  skybot: { name: 'SkyBoT', shape: '◇', what: 'asteroids' },
}
const KEYS = Object.keys(LABELS) as LayerKey[]

// Catalogue overlays, all off by default: every marker is a known source, nothing more.
export function CatalogLegend({ aladin, sizeDeg, frameMjd, children, onMarks }: Props) {
  const [enabled, setEnabled] = useState({ gaia: false, wise: false, simbad: false, skybot: false })
  const { status, skybotDate, marks } = useCatalogLayers(aladin, enabled, sizeDeg, frameMjd)
  useEffect(() => onMarks?.(marks), [marks, onMarks])
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
            ) : status[key] === 'none' ? (
              `${name}: no objects ${key === 'gaia' || key === 'simbad' ? `within ${NEAR_DEG}°` : 'in this field'}`
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
      {children}
      <p className="hint">
        A blinking source without a marker needs verification — it is not a discovery.
        {` Gaia DR3 and SIMBAD search within ${NEAR_DEG}° of the centre; Gaia DR3 and AllWISE show their ${MAX_SOURCES} brightest sources at most.`}
      </p>
    </div>
  )
}
