// "Already known?" for the user's marks: SkyBoT at each mark's own time, the field's JPL SBIdent
// answer, the snapped detection's catalogue match and the target's Gaia motion. All of it is
// positional coincidence; the verdict stays with the user.
import { propagateGaia } from './catalogLayers'
import { sepArcsec, type Mark } from './candidate'
import { epochFor, positionAt } from './smallBodyLayer'
import type { ProperMotion, SmallBodyEpoch } from './types'

const SKYBOT_URL = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php'
export const SKYBOT_RADIUS_DEG = 0.01
export const SKYBOT_TIMEOUT_MS = 25_000
// Geocentric positions vs SPHEREx in low Earth orbit: main-belt bodies sit about 4″ off.
export const MIN_MATCH_ARCSEC = 10
// Gaia-matched marks of a high proper-motion star stay within one SPHEREx pixel and a half.
export const FOLLOW_ARCSEC = 18.5
export const NOT_LISTED = `SkyBoT lists no known body within ${SKYBOT_RADIUS_DEG * 3600}″ at this time (not listed ≠ unknown)`
export const SBIDENT_NOT_LISTED = 'JPL SBIdent lists no known body here at this time (not listed ≠ unknown)'
export const NOT_REACHABLE = 'SkyBoT not reachable – try again'

export interface KnownBody {
  name: string
  sepArcsec: number
  // Arcsec per hour on the sky
  rate: number
  kind: string
}

export type SkybotAnswer = { bodies: KnownBody[] } | { error: string }

export const matchRadius = (sigmaArcsec: number) => Math.max(MIN_MATCH_ARCSEC, 2 * sigmaArcsec)

export function skybotUrl(mark: Pick<Mark, 'ra' | 'dec' | 'mjd'>): string {
  const params = new URLSearchParams({
    '-ep': String(mark.mjd + 2400000.5),
    '-ra': String(mark.ra),
    '-dec': String(mark.dec),
    '-rd': String(SKYBOT_RADIUS_DEG),
    '-mime': 'json',
    '-output': 'all',
    '-observer': '500',
    '-from': 'LoopTheDifference',
  })
  return `${SKYBOT_URL}?${params}`
}

interface SkybotRow {
  Num?: number | string | null
  Name: string
  Class?: string
  'd (arcsec)': number
  'dRA (arcsec/h)': number
  'dDEC (arcsec/h)': number
}

/** SkyBoT's JSON rows, nearest first; 204 (or an empty body) is an empty field. */
export function parseSkybot(status: number, text: string): KnownBody[] {
  if (status === 204 || text.trim() === '') return []
  const rows = JSON.parse(text) as SkybotRow[]
  return rows
    .map((row) => ({
      name: row.Num ? `(${row.Num}) ${row.Name}` : row.Name,
      sepArcsec: Number(row['d (arcsec)']),
      rate: Math.hypot(Number(row['dRA (arcsec/h)']), Number(row['dDEC (arcsec/h)'])),
      kind: (row.Class ?? '').split('>')[0],
    }))
    .sort((a, b) => a.sepArcsec - b.sepArcsec)
}

/** One cone at the mark's time; a timeout or network error is an error, never an empty field. */
export async function skybotCone(mark: Mark, signal: AbortSignal): Promise<SkybotAnswer> {
  try {
    const response = await fetch(skybotUrl(mark), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(SKYBOT_TIMEOUT_MS)]),
    })
    if (!response.ok) return { error: NOT_REACHABLE }
    return { bodies: parseSkybot(response.status, await response.text()) }
  } catch {
    return { error: NOT_REACHABLE }
  }
}

/** One cone per mark, one after the other; stops when the signal aborts. */
export async function checkMarks(marks: Mark[], signal: AbortSignal, onAnswer: (answer: SkybotAnswer) => void) {
  for (const mark of marks) {
    const answer = await skybotCone(mark, signal)
    if (signal.aborted) return
    onAnswer(answer)
  }
}

/** Within the match radius: possible; further out but inside the cone: nearby. */
export function matchBodies(bodies: KnownBody[], sigmaArcsec: number) {
  const radius = matchRadius(sigmaArcsec)
  return {
    possible: bodies.filter((b) => b.sepArcsec <= radius),
    nearby: bodies.filter((b) => b.sepArcsec > radius),
  }
}

/** The field's SBIdent bodies moved to the mark's time (answered epoch ≤ 1 d away); null without one. */
export function sbidentMatches(epochs: SmallBodyEpoch[], mark: Mark): KnownBody[] | null {
  const epoch = epochFor(epochs, mark.mjd)
  if (!epoch) return null
  const radius = matchRadius(mark.sigma_arcsec)
  return epoch.bodies
    .map((body) => {
      const at = positionAt(body, epoch.mjd, mark.mjd)
      return { name: body.name, sepArcsec: sepArcsec(mark.ra, mark.dec, at.ra, at.dec), rate: Math.hypot(body.ra_rate, body.dec_rate), kind: '' }
    })
    .filter((b) => b.sepArcsec <= radius)
    .sort((a, b) => a.sepArcsec - b.sepArcsec)
}

/** Both marks lie where Gaia puts the target star at their times. */
export function followsTarget(motion: ProperMotion | null, marks: Mark[]): boolean {
  if (!motion || marks.length < 2) return false
  return marks.every((mark) => {
    const at = propagateGaia(
      { ra: motion.ra, dec: motion.dec, pmRa: motion.pmra_mas_yr, pmDec: motion.pmdec_mas_yr },
      mark.mjd,
      motion.ref_epoch,
    )
    return sepArcsec(mark.ra, mark.dec, at.ra, at.dec) <= FOLLOW_ARCSEC
  })
}

/** Every mark snapped to the same Gaia/AllWISE source. */
export function sameCatalogueSource(marks: Mark[]): boolean {
  const ids = marks.map((m) => (m.source && (m.source.match === 'gaia' || m.source.match === 'allwise') ? m.source.catalog_id : null))
  return ids.length > 0 && ids[0] != null && ids.every((id) => id === ids[0])
}

export const rateText = (rate: number) => `${rate < 10 ? rate.toFixed(2) : rate.toFixed(1)}″/h`

export function bodyText(body: KnownBody): string {
  return `${body.name} · ${body.sepArcsec.toFixed(1)}″ · moves ${rateText(body.rate)}${body.kind ? ` · class ${body.kind}` : ''}`
}
