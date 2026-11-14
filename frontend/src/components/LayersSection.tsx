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
  sourcesOnSky: boolean
  onSourcesOnSkyChange: (on: boolean) => void
  // Why the frames cannot go on the sky right now.
  framesBlocked?: string
}

// Everything the app draws on the Aladin sky: the SPHEREx frames, their detected sources and the catalogue markers.
export function LayersSection({ aladin, ra, dec, sizeDeg, frame, framesOnSky, onFramesOnSkyChange, sourcesOnSky, onSourcesOnSkyChange, framesBlocked }: Props) {
  const blocked = !aladin || !frame || !!framesBlocked
  return (
    <section className="layers-section" aria-labelledby="layers-heading">
      <h3 id="layers-heading">Layers on the sky</h3>
      <label className="layer-toggle">
        <input type="checkbox" checked={framesOnSky} disabled={blocked}
          onChange={(event) => onFramesOnSkyChange(event.target.checked)} />
        SPHEREx frames on the sky
      </label>
      <label className="layer-toggle">
        <input type="checkbox" checked={sourcesOnSky} disabled={blocked} aria-describedby="source-key"
          onChange={(event) => onSourcesOnSkyChange(event.target.checked)} />
        Sources detected in the shown frame
      </label>
      <p className="source-key" id="source-key">
        <span className="src-gaia" aria-hidden="true">+</span> catalogue match · <span className="src-none" aria-hidden="true">×</span> no
        match, needs verification · <span className="src-unknown" aria-hidden="true">×</span> in grey: catalogue unavailable
      </p>
      {(!frame || framesBlocked) && <p className="muted">{framesBlocked ?? 'Load a comparison to place its frames and their detected sources on the sky. Gaia DR3 and SkyBoT follow the date of the shown frame, so they wait for frames too.'}</p>}
      <CatalogLegend aladin={aladin} ra={ra} dec={dec} sizeDeg={sizeDeg} frameMjd={frame?.mjd ?? null} />
    </section>
  )
}
