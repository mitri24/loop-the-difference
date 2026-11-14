import type { AladinInstance } from 'aladin-lite'
import { TRACK_LABEL } from '../motionTrack'
import type { PlateState } from '../historicalPlate'
import { POSSIBLE_TRACK_LABEL } from '../trackLayer'
import { epochFor } from '../smallBodyLayer'
import type { Frame, SmallBodyEpoch } from '../types'
import { CatalogLegend } from './CatalogLegend'
import { SkySlider } from './SkySlider'

interface Props {
  aladin: AladinInstance | null
  sizeDeg: number
  // The frame the player has selected; null until a comparison has frames.
  frame: Frame | null
  framesOnSky: boolean
  onFramesOnSkyChange: (on: boolean) => void
  sourcesOnSky: boolean
  onSourcesOnSkyChange: (on: boolean) => void
  // Why the frames cannot go on the sky right now.
  framesBlocked?: string
  // The Gaia DR3 track of a named star is drawn on the sky.
  trackShown: boolean
  // The possible track from the user's marks is drawn on the sky.
  possibleTrackShown?: boolean
  skySlice: number
  onSkySliceChange: (slice: number) => void
  cubeActive: boolean
  // Answered JPL SBIdent epochs; empty until the lookup in Compare has run.
  smallBodyEpochs: SmallBodyEpoch[]
  smallBodiesOnSky: boolean
  onSmallBodiesOnSkyChange: (on: boolean) => void
  // The 1950 POSS-I plate needs a named star with Gaia DR3 motion.
  plateAvailable: boolean
  plateOnSky: boolean
  onPlateOnSkyChange: (on: boolean) => void
  plate: PlateState
}

const PLATE_STATUS: Record<Exclude<PlateState['status'], 'loaded'>, string> = {
  off: '',
  loading: 'Loading the plate from STScI…',
  failed: 'Historical plate not available (STScI)',
  south: 'No POSS-I plate for this declination',
}

// Everything the app draws on the Aladin sky: the SPHEREx frames, their detected sources and the catalogue markers.
export function LayersSection({ aladin, sizeDeg, frame, framesOnSky, onFramesOnSkyChange, sourcesOnSky, onSourcesOnSkyChange, framesBlocked,
  trackShown, possibleTrackShown, skySlice, onSkySliceChange, cubeActive, smallBodyEpochs, smallBodiesOnSky, onSmallBodiesOnSkyChange,
  plateAvailable, plateOnSky, onPlateOnSkyChange, plate }: Props) {
  const blocked = !aladin || !frame || !!framesBlocked
  const answered = smallBodyEpochs.some((epoch) => epoch.error == null)
  const jplEpoch = frame ? epochFor(smallBodyEpochs, frame.mjd) : null
  const jplState = smallBodyEpochs.length === 0 ? ' · look them up below' : !answered ? ' · JPL did not answer'
    : jplEpoch ? ` @ ${jplEpoch.date.slice(0, 10)}` : ' · no lookup within a day of this frame'
  return (
    <section className="layers-section" aria-labelledby="layers-heading">
      <h3 id="layers-heading">Layers on the sky</h3>
      <label className="layer-toggle">
        <input type="checkbox" checked={framesOnSky} disabled={blocked}
          onChange={(event) => onFramesOnSkyChange(event.target.checked)} />
        SPHEREx frames on the sky
      </label>
      <label className="layer-toggle">
        <input type="checkbox" checked={plateOnSky && plateAvailable} disabled={!aladin || !plateAvailable}
          aria-describedby="plate-status" onChange={(event) => onPlateOnSkyChange(event.target.checked)} />
        Photographic plate 1950 (POSS-I, STScI DSS) – position check
      </label>
      <p className="muted plate-status" id="plate-status" role="status">
        {!plateAvailable ? 'Needs a star with Gaia DR3 motion (find it by name)'
          : plate.status === 'loaded'
            ? <>{plate.header.survey} plate {plate.header.plateId}, observed {plate.header.date}. <span className="plate-key" aria-hidden="true">○</span> Gaia DR3 predicted
              position on {plate.header.date}. Different telescope and wavelength (photographic red): compare positions, not brightness.</>
            : PLATE_STATUS[plate.status]}
      </p>
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
      {trackShown && <p className="track-key"><span aria-hidden="true">─●─</span> Path {TRACK_LABEL}, a dot per frame date</p>}
      {possibleTrackShown && <p className="track-key possible"><span aria-hidden="true">◎</span> {POSSIBLE_TRACK_LABEL}</p>}
      <CatalogLegend aladin={aladin} sizeDeg={sizeDeg} frameMjd={frame?.mjd ?? null}>
        <label>
          <input type="checkbox" checked={smallBodiesOnSky} disabled={!aladin || !answered}
            onChange={(event) => onSmallBodiesOnSkyChange(event.target.checked)} />
          JPL SBIdent <span style={{ color: 'var(--cat-sbident)' }}>◇</span> named asteroids{jplState}
        </label>
      </CatalogLegend>
      <SkySlider value={skySlice} onChange={onSkySliceChange} active={cubeActive} />
    </section>
  )
}
