// Where to look in older observations: the possible track's prediction at each SPHEREx visit and at
// historical epochs, with links centred on it. Links and predictions only; nothing is fetched here.
import type { Mark } from './candidate'
import { irsaViewerUrl, wiseViewUrl, type DataLink } from './dataLinks'
import { dssUrl, POSS_I_MIN_DEC } from './historicalPlate'
import { FAST_WINDOW_DAYS, predict, type PossibleTrack, type Prediction } from './track'
import type { Observation } from './types'

export const MIN_CUTOUT_DEG = 0.02
export const MAX_CHECK_DEG = 0.5
const MJD_J2000 = 51544.5
export const yearToMjd = (year: number) => MJD_J2000 + (year - 2000) * 365.25

export const NOT_A_LINE = 'No straight-line prediction'
export const PLATE_NOTE = 'plate date inside the file; time not printed'

export interface LookRow {
  key: string
  when: string
  source: string
  inBlink: boolean
  at: Prediction | null
  links: DataLink[]
  // Why there are no links for this row.
  note: string | null
}

const round = (value: number, digits: number) => Number(value.toFixed(digits))

/** Field of a cutout around a prediction: the 2σ circle plus a margin, within [0.02°, 0.5°]. */
export const cutoutDeg = (radiusArcsec: number) =>
  Math.min(Math.max((2 * radiusArcsec) / 3600 + MIN_CUTOUT_DEG, MIN_CUTOUT_DEG), MAX_CHECK_DEG)

export const cutoutUrl = (accessUrl: string, at: Prediction) =>
  `${accessUrl}?center=${at.ra.toFixed(6)},${at.dec.toFixed(6)}&size=${cutoutDeg(at.radius_arcsec).toFixed(4)}`

/** True where a straight line from the marks is a valid prediction (see track.ts `possibleTrack`). */
export function lineValid({ regime }: PossibleTrack, marks: Pick<Mark, 'mjd'>[], mjd: number): boolean {
  if (regime === 'stellar' || regime === 'none') return true
  if (regime === 'solarSystem') return false
  const mjds = marks.map((m) => m.mjd)
  return mjd >= Math.min(...mjds) - FAST_WINDOW_DAYS && mjd <= Math.max(...mjds) + FAST_WINDOW_DAYS
}

// The prediction, or why it cannot be checked.
function checkable(track: PossibleTrack, marks: Pick<Mark, 'mjd'>[], mjd: number): { at: Prediction | null; note: string | null } {
  if (!lineValid(track, marks, mjd)) return { at: null, note: NOT_A_LINE }
  const at = predict(track.fit, mjd)
  if (at.radius_arcsec / 3600 > MAX_CHECK_DEG) return { at, note: `Too uncertain to check (±${Math.round(at.radius_arcsec / 60)}′)` }
  return { at, note: null }
}

/** Every SPHEREx visit on the blink's detector, newest first, with the prediction at its own time. */
export function visitRows(
  observations: Observation[], detector: number, inBlink: string[], track: PossibleTrack, marks: Pick<Mark, 'mjd'>[],
): LookRow[] {
  const blink = new Set(inBlink)
  return observations
    .filter((obs) => obs.detector === detector)
    .sort((a, b) => b.mjd - a.mjd)
    .map((obs) => {
      const { at, note } = checkable(track, marks, obs.mjd)
      const cutout = at && !note ? cutoutUrl(obs.access_url, at) : null
      return {
        key: obs.obs_id, when: `${obs.date.slice(0, 16).replace('T', ' ')} UTC`, source: obs.obs_id,
        inBlink: blink.has(obs.obs_id), at, note,
        links: cutout ? [
          { label: 'Cutout at the predicted position (FITS, IRSA, ~4 MB+)', site: 'IRSA', url: cutout },
          { label: 'Open in IRSA Viewer', site: 'IRSA Viewer', url: irsaViewerUrl(cutout) },
        ] : [],
      }
    })
}

const HISTORICAL = [
  { key: 'wise', year: 2017, source: 'WISE/NEOWISE' },
  { key: 'poss2', year: 1991, source: 'POSS-II red', survey: 'poss2ukstu_red' },
  { key: 'poss1', year: 1953, source: 'POSS-I red', survey: 'poss1_red' },
] as const

/** WISE and plate epochs, only where a straight line holds for years (stellar or no significant motion). */
export function historicalRows(track: PossibleTrack, detector: number): LookRow[] {
  if (track.regime !== 'stellar' && track.regime !== 'none') return []
  return HISTORICAL.map((epoch) => {
    const { at, note } = checkable(track, [], yearToMjd(epoch.year))
    const row = { key: epoch.key, when: `${epoch.year}.0`, source: epoch.source, inBlink: false, at }
    if (note || !at) return { ...row, note, links: [] }
    if (!('survey' in epoch)) {
      return { ...row, note: null, links: [{ label: 'WiseView blinks 2010–2024', site: 'WiseView', url: wiseViewUrl(at.ra, at.dec, detector) }] }
    }
    if (epoch.key === 'poss1' && at.dec < POSS_I_MIN_DEC) return { ...row, note: 'POSS-I covers only north of −30°', links: [] }
    const arcmin = round(cutoutDeg(at.radius_arcsec) * 60, 2)
    const url = dssUrl(round(at.ra, 6), round(at.dec, 6), arcmin, epoch.survey, 'gif')
    return { ...row, note: null, links: [{ label: `Plate cutout (GIF), ${PLATE_NOTE}`, site: 'STScI DSS', url }] }
  })
}
