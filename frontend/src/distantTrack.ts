// Where a possible distant Solar System object would be in the other images, for assumed distances
// (POST /api/track/distant: straight-line heliocentric motion plus Earth's parallax, not an orbit),
// and which uncatalogued detections lie there. The app never decides that one of them is the object.
import type { AladinInstance } from 'aladin-lite'
import { useEffect, useMemo, useState } from 'react'
import { createDistantTrack } from './api'
import { insideFrame, nearestSource, sepArcsec, type Mark } from './candidate'
import { lineValid } from './precovery'
import { searchRadius, type PossibleTrack, type Regime } from './track'
import { useDistantTrackLayer } from './trackLayer'
import type { DetectedSource, DistanceGrid, DistantTrack, DistantTrackRequest, Frame, FrameManifest, TrackMark } from './types'

// Limits of DistanceGrid and DistantTrackRequest in backend/app/models.py (TRACK_WINDOW_DAYS): the marks
// 1.5 minutes to 400 days apart, every target time within 400 days of both.
const MIN_MARK_GAP_DAYS = 0.001
export const TRACK_WINDOW_DAYS = 400
export const MAX_TARGETS = 24
export const MIN_AU = 20
export const MAX_AU = 2000
const STEPS = 64
// Earth's mean orbital speed 29.8 km/s plus the escape speed 19 AU from the Sun, 9.7 km/s: a bound object
// Δ ≥ 20 AU away crosses the sky at most 0.0228 AU/day, 4700/Δ ″/day. Farther out the escape speed drops,
// so the farthest distance this allows errs on the far side. Marks of different epochs give the mean rate
// between them, never more than the fastest rate in between: the bound holds there too.
const REACH = 4700

/** The farthest distance in AU at which a bound object still moves `rate` ″/day, at most 2000 AU. */
export const farthestAu = (rate: number) => (rate > 0 ? Math.min(MAX_AU, REACH / rate) : MAX_AU)

// Significant motion that may be a distant object: within one epoch, or across epochs and not a straight line.
const DISTANT_REGIMES: Regime[] = ['fast', 'solarSystem']

// Why no distances can be asked for: too fast for 20 AU, or the marks closer or farther apart in time than the API takes.
export type GridBlock = 'tooFast' | 'marksTooClose' | 'marksTooFar'

const trackMark = ({ ra, dec, mjd, sigma_arcsec }: Mark): TrackMark => ({ ra: String(ra), dec: String(dec), mjd, sigma_arcsec })

/**
 * Null unless two marks show motion that may be a distant object (fast or solarSystem). Else 20 AU up to the
 * farthest distance the marks' motion (less 3σ) allows a bound object, or why nothing can be asked.
 */
export function distanceGrid(track: PossibleTrack | null, marks: Mark[]): { grid: DistanceGrid } | { blocked: GridBlock } | null {
  if (!track || !DISTANT_REGIMES.includes(track.regime) || marks.length !== 2) return null
  const gap = Math.abs(marks[1].mjd - marks[0].mjd)
  const farthest = farthestAu(track.fit.rate - 3 * track.fit.sigmaRate)
  if (farthest <= MIN_AU) return { blocked: 'tooFast' }
  if (gap < MIN_MARK_GAP_DAYS) return { blocked: 'marksTooClose' }
  if (gap > TRACK_WINDOW_DAYS) return { blocked: 'marksTooFar' }
  return { grid: { marks: [trackMark(marks[0]), trackMark(marks[1])], d_min_au: MIN_AU, d_max_au: farthest, steps: STEPS } }
}

type Grid = Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'pixel_scale_arcsec'>
export type DistantField = Grid & Pick<FrameManifest, 'frames'>

export interface DistantPlan {
  // The other images beyond the straight-line window, in time order; `skip` says why one is not predicted.
  frames: { frame: Frame; skip: 'tooFar' | 'overLimit' | null }[]
  blocked: GridBlock | null
  request: DistantTrackRequest | null
}

const days = (marks: Pick<Mark, 'mjd'>[], mjd: number) => marks.map((m) => Math.abs(mjd - m.mjd))

/**
 * Null unless two marks show motion that may be a distant object, within one epoch or across epochs, and other
 * images lie beyond the straight-line window. Asks for the distance grid at those within 400 days of both marks.
 */
export function planDistantTrack(track: PossibleTrack | null, marks: Mark[], frames: Frame[]): DistantPlan | null {
  const asked = distanceGrid(track, marks)
  if (!asked || !track) return null
  const marked = new Set(marks.map((m) => m.obs_id))
  const others = frames
    .filter((f) => !marked.has(f.obs_id) && !lineValid(track, marks, f.mjd))
    .sort((a, b) => a.mjd - b.mjd)
  if (others.length === 0) return null
  // The model error grows with time: the times nearest to a mark go first.
  const targets = new Set([...new Set(others.map((f) => f.mjd))]
    .filter((mjd) => Math.max(...days(marks, mjd)) <= TRACK_WINDOW_DAYS)
    .sort((a, b) => Math.min(...days(marks, a)) - Math.min(...days(marks, b)))
    .slice(0, MAX_TARGETS))
  return {
    frames: others.map((frame) => ({
      frame,
      skip: targets.has(frame.mjd) ? null : Math.max(...days(marks, frame.mjd)) > TRACK_WINDOW_DAYS ? 'tooFar' : 'overLimit',
    })),
    blocked: 'blocked' in asked ? asked.blocked : null,
    request: 'grid' in asked && targets.size > 0 ? { ...asked.grid, target_mjds: [...targets].sort((a, b) => a - b) } : null,
  }
}

export interface Nearest {
  source: DetectedSource
  sep_arcsec: number
}

type DistantResult =
  // `inside`: indices of the distances whose position falls in the field; `hits`: those with a counted detection
  // in their search circle; `unknown`: hits made only by detections without a catalogue answer.
  | { kind: 'fits'; inside: number[]; hits: number[]; unknown: number[]; nearest: Nearest }
  | { kind: 'nothing'; inside: number[]; nearest: Nearest | null }
  | { kind: 'outside'; offset_deg: number }
  | { kind: 'noSources' | 'tooFar' | 'overLimit' }

export interface DistantRow {
  frame: Frame
  result: DistantResult
}

// A catalogued source sits in every image at the same place: it is not the moving object. A detection without
// a catalogue answer ('unknown') still counts, and its rows say so.
const counted = (source: DetectedSource) => source.match === 'none' || source.match === 'unknown'

/** Per other image: which assumed distances fall in the field and which put a counted detection in their search circle. */
export function checkDistant(plan: DistantPlan, track: DistantTrack | null, grid: Grid): DistantRow[] {
  return plan.frames.map(({ frame, skip }): DistantRow => {
    if (skip) return { frame, result: { kind: skip } }
    const positions = (track?.hypotheses ?? []).flatMap((h, i) => {
      const point = h.points.find((p) => Math.abs(p.mjd - frame.mjd) < 1e-6)
      return point ? [{ i, point }] : []
    })
    const inField = positions.filter(({ point }) => insideFrame(point.ra, point.dec, grid))
    if (inField.length === 0) {
      const offsets = positions.map(({ point }) => sepArcsec(grid.ra, grid.dec, point.ra, point.dec) / 3600)
      return { frame, result: { kind: 'outside', offset_deg: Math.min(...offsets) } }
    }
    if (!frame.sources) return { frame, result: { kind: 'noSources' } }
    const sources = frame.sources.filter(counted)
    const answered = sources.filter((s) => s.match === 'none')
    const inside = inField.map(({ i }) => i)
    const hits: number[] = []
    const unknown: number[] = []
    let nearest: Nearest | null = null
    for (const { i, point } of inField) {
      const found = nearestSource(sources, point.ra, point.dec, Infinity)
      if (!found) continue
      if (!nearest || found.sep_arcsec < nearest.sep_arcsec) nearest = found
      const radius = searchRadius(point.radius_arcsec, grid.pixel_scale_arcsec, point.model_error_arcsec ?? 0)
      if (found.sep_arcsec > radius) continue
      hits.push(i)
      if (!nearestSource(answered, point.ra, point.dec, radius)) unknown.push(i)
    }
    return {
      frame,
      result: nearest && hits.length > 0 ? { kind: 'fits', inside, hits, unknown, nearest } : { kind: 'nothing', inside, nearest },
    }
  })
}

/** [first, last] index of each run of neighbouring indices. */
function runs(indices: number[]): [number, number][] {
  const out: [number, number][] = []
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && last[1] === i - 1) last[1] = i
    else out.push([i, i])
  }
  return out
}

/** Hypothesis indices as distance ranges in AU, [nearest, farthest] each. */
export const distanceRanges = (indices: number[], distances: number[]): [number, number][] =>
  runs(indices).map(([a, b]) => [distances[a], distances[b]])

/** The distances whose position fell outside the field, as ranges. */
export const outsideRanges = (inside: number[], distances: number[]) =>
  distanceRanges(distances.flatMap((_, i) => (inside.includes(i) ? [] : [i])), distances)

export type DistantSummary =
  // checked: images in which these distances fell in the field; outside: images in which they did not.
  | { kind: 'fits'; ranges: [number, number][]; images: number; checked: number; outside: number; unknownOnly: boolean }
  | { kind: 'nothing'; checked: number; outside: number }
  | { kind: 'outside'; offset_deg: number }
  | { kind: 'unchecked' }

/**
 * The distances with a counted detection in the most images, each distance counted only over the images in
 * which its position fell in the field; among equals the fewest misses win. Else nothing found, positions off
 * the field, or nothing checkable.
 */
export function summarizeDistant(rows: DistantRow[], distances: number[]): DistantSummary {
  const votes = distances.map(() => 0)
  const answered = distances.map(() => 0)
  const seen = distances.map(() => 0)
  let checked = 0
  let outside = 0
  let offset = Infinity
  for (const { result } of rows) {
    if (result.kind === 'fits' || result.kind === 'nothing') {
      checked += 1
      for (const i of result.inside) seen[i] += 1
    }
    if (result.kind === 'fits') {
      for (const i of result.hits) {
        votes[i] += 1
        if (!result.unknown.includes(i)) answered[i] += 1
      }
    }
    if (result.kind === 'outside') {
      outside += 1
      offset = Math.min(offset, result.offset_deg)
    }
  }
  const most = Math.max(0, ...votes)
  if (most > 0) {
    const fewest = Math.min(...votes.flatMap((v, i) => (v === most ? [seen[i]] : [])))
    const best = votes.flatMap((v, i) => (v === most && seen[i] === fewest ? [i] : []))
    return {
      kind: 'fits', ranges: distanceRanges(best, distances), images: most, checked: fewest,
      outside: checked + outside - fewest, unknownOnly: best.every((i) => answered[i] === 0),
    }
  }
  if (checked > 0) return { kind: 'nothing', checked, outside }
  if (outside > 0) return { kind: 'outside', offset_deg: offset }
  return { kind: 'unchecked' }
}

/** The image whose line carries the distance labels: farthest in time from the marks, among those in the field if any. */
export function labelTime(rows: DistantRow[], marks: Pick<Mark, 'mjd'>[]): number | null {
  const predicted = rows.filter(({ result }) => !['tooFar', 'overLimit'].includes(result.kind))
  const inField = predicted.filter(({ result }) => result.kind !== 'outside')
  let best: number | null = null
  for (const { frame } of inField.length > 0 ? inField : predicted) {
    if (best == null || Math.min(...days(marks, frame.mjd)) > Math.min(...days(marks, best))) best = frame.mjd
  }
  return best
}

interface DistantAnswer {
  key: string
  attempt: number
  track?: DistantTrack
  error?: string
}

/** True for the answer to this request and attempt; one for other marks or an earlier attempt is stale. */
export const isCurrent = (answer: DistantAnswer, key: string, attempt: number) => answer.key === key && answer.attempt === attempt

export interface DistantTrackState {
  status: 'off' | GridBlock | 'loading' | 'error' | 'ready'
  // The assumed distances asked for, nearest and farthest, in AU.
  range: [number, number] | null
  error: string | null
  track: DistantTrack | null
  rows: DistantRow[]
  summary: DistantSummary | null
  retry: () => void
}

/** What the panel shows for a plan, its request key and the current answer to that request. */
export function distantState(
  plan: DistantPlan | null, key: string, current: DistantAnswer | null, rows: DistantRow[],
): Omit<DistantTrackState, 'retry'> {
  const off: Omit<DistantTrackState, 'retry'> = { status: 'off', range: null, error: null, track: null, rows: [], summary: null }
  if (!plan) return off
  if (plan.blocked) return { ...off, status: plan.blocked }
  const range: [number, number] | null = plan.request ? [plan.request.d_min_au ?? MIN_AU, plan.request.d_max_au ?? MAX_AU] : null
  if (key && !current) return { ...off, status: 'loading', range }
  if (current?.error) return { ...off, status: 'error', range, error: current.error }
  const track = key ? current?.track ?? null : null
  const distances = track?.hypotheses.map((h) => h.distance_au) ?? []
  return { ...off, status: 'ready', range, track, rows, summary: summarizeDistant(rows, distances) }
}

export const errorText = (cause: unknown) =>
  cause instanceof DOMException && cause.name === 'TimeoutError' ? 'The data service timed out. Retry in a moment.'
    : cause instanceof Error ? cause.message : String(cause)

/**
 * Positions for assumed distances in the images beyond the straight-line window, checked against their
 * detections and drawn on `aladin`. New marks abort the request still running for the old ones.
 */
export function useDistantTrack(
  aladin: AladinInstance | null, track: PossibleTrack | null, marks: Mark[], field: DistantField | null | undefined,
): DistantTrackState {
  const plan = useMemo(() => (field ? planDistantTrack(track, marks, field.frames) : null), [track, marks, field])
  const key = plan?.request ? JSON.stringify(plan.request) : ''
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<DistantAnswer>({ key: '', attempt: 0 })

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    createDistantTrack(JSON.parse(key) as DistantTrackRequest, controller.signal).then(
      (distant) => setAnswer({ key, attempt, track: distant }),
      (cause: unknown) => {
        if (!controller.signal.aborted) setAnswer({ key, attempt, error: errorText(cause) })
      },
    )
    return () => controller.abort()
  }, [key, attempt])

  const current = isCurrent(answer, key, attempt) ? answer : null
  const distant = key ? current?.track ?? null : null
  const rows = useMemo(
    () => (plan && field && !plan.blocked && (!key || distant) ? checkDistant(plan, distant, field) : []),
    [plan, field, key, distant],
  )
  useDistantTrackLayer(aladin, distant, labelTime(rows, marks), field?.pixel_scale_arcsec ?? 0)
  return { ...distantState(plan, key, current, rows), retry: () => setAttempt((n) => n + 1) }
}
