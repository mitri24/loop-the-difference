import type { AladinInstance } from 'aladin-lite'
import type { Frame } from '../types'
import { CatalogLegend } from './CatalogLegend'

interface Props {
  aladin: AladinInstance | null
  ra: number
  dec: number
  sizeDeg: number
  // The frame the player has selected; null until a comparison has frames.
  frame: Frame | null
  framesOnSky: boolean
  onFramesOnSkyChange: (on: boolean) => void
  // Why the frames cannot go on the sky right now.
  framesBlocked?: string
}

// Everything the app draws on the Aladin sky: the SPHEREx frames and the catalogue markers.
export function LayersSection({ aladin, ra, dec, sizeDeg, frame, framesOnSky, onFramesOnSkyChange, framesBlocked }: Props) {
  return (
    <section className="layers-section" aria-labelledby="layers-heading">
      <h3 id="layers-heading">Layers on the sky</h3>
      <label className="layer-toggle">
        <input type="checkbox" checked={framesOnSky} disabled={!aladin || !frame || !!framesBlocked}
          onChange={(event) => onFramesOnSkyChange(event.target.checked)} />
        SPHEREx frames on the sky
      </label>
      {(!frame || framesBlocked) && <p className="muted">{framesBlocked ?? 'Load a comparison to place its frames on the sky. Gaia DR3 and SkyBoT follow the date of the shown frame, so they wait for frames too.'}</p>}
      <CatalogLegend aladin={aladin} ra={ra} dec={dec} sizeDeg={sizeDeg} frameMjd={frame?.mjd ?? null} />
    </section>
  )
}
