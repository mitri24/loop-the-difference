// Follow-up of a possible track (POST /api/followup, backend/app/followup.py): the worker measures the flux where
// the track puts the object in the detector's other SPHEREx visits and stacks it per assumed distance, or along the
// straight line. Started on request only, since every visit is an IRSA cutout. It tests a candidate, never confirms one.
import { useEffect, useState } from 'react'
import { createFollowup, getFollowupJob } from './api'
import type { Mark } from './candidate'
import { distanceGrid, errorText } from './distantTrack'
import { num, predict, type PossibleTrack } from './track'
import type {
  Followup, FollowupHypothesis, FollowupJob, FollowupMeasurement, FollowupPoint, FollowupRequest, Frame, FrameManifest, MarkedFrame,
  NotCoveredReason, Observation,
} from './types'

const POLL_MS = 3000
// FollowupRequest.points in backend/app/models.py: at most this many straight-line positions.
export const MAX_POINTS = 1000

export type FollowupField = Pick<FrameManifest, 'ra' | 'dec' | 'detector' | 'frames'>

// What the follow-up measures along: the assumed distances of two marks (fast or solarSystem, the same grid as the
// distant-object track) or the straight line of stellar motion.
export type FollowupKind = 'distances' | 'line'

/** Null unless two marks give a track to test; no significant motion, or marks the API does not take, give none. */
export function followupKind(track: PossibleTrack | null, marks: Mark[]): FollowupKind | null {
  if (!track || marks.length !== 2) return null
  if (track.regime === 'stellar') return 'line'
  const asked = distanceGrid(track, marks)
  return asked && 'grid' in asked ? 'distances' : null
}

/** The marks' frames as the API takes them: a stack with the span of its exposures, so none of them is measured. */
export function markedFrames(marks: Mark[], frames: Frame[]): MarkedFrame[] {
  return marks.map((mark) => {
    const frame = frames.find((f) => f.obs_id === mark.obs_id)
    return { obs_id: mark.obs_id, date: frame?.date ?? (mark.date || null), date_end: frame?.date_end ?? null }
  })
}

/** The straight line at every visit time of the detector, at most MAX_POINTS spread over all of them. */
export function linePoints(track: PossibleTrack, observations: Observation[], detector: number): FollowupPoint[] {
  const mjds = [...new Set(observations.filter((o) => o.detector === detector).map((o) => o.mjd))].sort((a, b) => a - b)
  const kept = mjds.length <= MAX_POINTS ? mjds
    : Array.from({ length: MAX_POINTS }, (_, i) => mjds[Math.round((i * (mjds.length - 1)) / (MAX_POINTS - 1))])
  return kept.map((mjd) => {
    const { ra, dec, radius_arcsec } = predict(track.fit, mjd)
    return { mjd, ra, dec, radius_arcsec }
  })
}

/**
 * The request for these marks: the distance grid of the marks, or the straight line at the visits the archive lists
 * for the field (`observations`). Null when there is no track to test or no visit of the detector is known.
 */
export function followupRequest(
  track: PossibleTrack | null, marks: Mark[], field: FollowupField, observations: Observation[] | null,
): FollowupRequest | null {
  const kind = followupKind(track, marks)
  if (!kind || !track) return null
  const base = { ra: String(field.ra), dec: String(field.dec), detector: field.detector, marked: markedFrames(marks, field.frames) }
  if (kind === 'line') {
    const points = linePoints(track, observations ?? [], field.detector)
    return points.length > 0 ? { ...base, points } : null
  }
  const asked = distanceGrid(track, marks)
  return asked && 'grid' in asked ? { ...base, grid: asked.grid } : null
}

export interface FollowupRun {
  // The marks the run belongs to (runKey) and its attempt: an answer for other marks or an earlier attempt is stale.
  key: string
  attempt: number
  request: FollowupRequest | null
  job: FollowupJob | null
  error: string | null
}

const NO_RUN: FollowupRun = { key: '', attempt: 0, request: null, job: null, error: null }

/** Identity of the marks on this field: new marks start without a run and stop the old one. */
export const runKey = (marks: Mark[], field: Pick<FrameManifest, 'ra' | 'dec' | 'detector'>, kind: FollowupKind) =>
  JSON.stringify([kind, field.ra, field.dec, field.detector, marks.map((m) => [m.obs_id, m.ra, m.dec, m.mjd, m.sigma_arcsec])])

/** The run of these marks; a run started for other marks is neither shown nor polled. */
export const currentRun = (run: FollowupRun, key: string): FollowupRun | null => (key !== '' && run.key === key ? run : null)

/** An answer changes the run only for the marks and the attempt it was asked for; a late one is dropped. */
export const withAnswer = (run: FollowupRun, key: string, attempt: number, change: Pick<Partial<FollowupRun>, 'job' | 'error'>) =>
  run.key === key && run.attempt === attempt ? { ...run, ...change } : run

export type FollowupPhase = 'idle' | 'sending' | 'running' | 'done' | 'error'

export function followupPhase(run: FollowupRun | null): FollowupPhase {
  if (!run?.request) return 'idle'
  if (run.error) return 'error'
  if (!run.job) return 'sending'
  if (run.job.status === 'queued' || run.job.status === 'started') return 'running'
  return run.job.status === 'finished' && run.job.followup ? 'done' : 'error'
}

/** Why the run has no result: the request failed, the job failed, or the job is gone. */
export function runError(run: FollowupRun | null): string | null {
  if (!run || followupPhase(run) !== 'error') return null
  if (run.error) return run.error
  if (run.job?.status === 'failed') return run.job.error ?? 'The follow-up job failed.'
  return 'The follow-up job expired.'
}

export interface FollowupState {
  // Null: these marks give no track to follow up, and nothing is offered.
  kind: FollowupKind | null
  phase: FollowupPhase
  job: FollowupJob | null
  followup: Followup | null
  error: string | null
  // A straight line needs the archive's visits of the field: true when they hold one of the detector.
  ready: (observations: Observation[] | null) => boolean
  // Starts the job, or again after an error or an incomplete result.
  start: (observations: Observation[] | null) => void
}

/**
 * The follow-up of the possible track through the marks, started with `start` (never by itself: it loads IRSA
 * cutouts). New marks abort the request or the polling for the old ones.
 */
export function useFollowup(track: PossibleTrack | null, marks: Mark[], field: FollowupField | null | undefined): FollowupState {
  const kind = field ? followupKind(track, marks) : null
  const key = kind && field ? runKey(marks, field, kind) : ''
  const [run, setRun] = useState(NO_RUN)
  const current = currentRun(run, key)
  const phase = followupPhase(current)
  const attempt = current?.attempt ?? 0
  const request = current?.request ?? null
  const job = current?.job ?? null

  useEffect(() => {
    if (phase !== 'sending' || !request) return
    const controller = new AbortController()
    createFollowup(request, controller.signal).then(
      (next) => setRun((old) => withAnswer(old, key, attempt, { job: next })),
      (cause: unknown) => {
        if (!controller.signal.aborted) setRun((old) => withAnswer(old, key, attempt, { error: errorText(cause) }))
      },
    )
    return () => controller.abort()
  }, [phase, request, key, attempt])

  useEffect(() => {
    if (phase !== 'running' || !job) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getFollowupJob(job.job_id, controller.signal).then(
        (next) => setRun((old) => withAnswer(old, key, attempt, { job: next })),
        (cause: unknown) => {
          if (!controller.signal.aborted) setRun((old) => withAnswer(old, key, attempt, { error: errorText(cause) }))
        },
      )
    }, POLL_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [phase, job, key, attempt])

  return {
    kind,
    phase,
    job,
    followup: phase === 'done' ? job?.followup ?? null : null,
    error: runError(current),
    ready: (observations) => kind === 'distances' || (kind === 'line' && !!field && !!observations?.some((o) => o.detector === field.detector)),
    start: (observations) => {
      const next = key && field ? followupRequest(track, marks, field, observations) : null
      if (next) setRun((old) => ({ key, attempt: old.attempt + 1, request: next, job: null, error: null }))
    },
  }
}

/** While the job runs: waiting, searching the archive, then the cutouts loaded so far. */
export function progressText(job: FollowupJob | null): string {
  if (!job) return 'Follow-up: starting…'
  if (job.status === 'queued') return 'Follow-up: waiting for a free worker…'
  if (job.total === 0) return 'Follow-up: searching the archive for visits…'
  return `Follow-up: ${job.progress} of ${job.total} cutouts…`
}

export interface Significance {
  // The best S/N corrected for trying `trials` independent distances (look-elsewhere), in σ.
  sigma: number
  trials: number
}

/** The look-elsewhere corrected significance, when more than one independent distance was tried. */
export const globalSignificance = ({ global_sigma, independent_trials }: Followup): Significance | null =>
  independent_trials > 1 && global_sigma != null ? { sigma: global_sigma, trials: independent_trials } : null

// Why visits or positions gave no usable flux, one phrase per code of Followup.not_covered_reasons.
const SHORTFALLS: Record<NotCoveredReason, string> = {
  outside_image: 'positions outside the images',
  search_circle_too_wide: 'positions too uncertain',
  model_error_too_large: 'positions too uncertain',
  image_edge: 'positions at the image edge',
  flagged_pixels: 'flagged pixels',
  cutout_missing: 'cutouts not delivered',
  search_unanswered: 'archive searches unanswered',
  release_unavailable: 'a SPHEREx release not searchable',
  no_flux: 'no flux at some positions',
  thinned: 'visits left out for the 48-cutout budget',
  not_searched: 'positions not searched',
  beyond_window: 'other visits more than 400 days from the marks',
  no_prediction: 'visits without a predicted position',
  unmatched_prediction: 'positions matching no visit',
}

export const shortfalls = (reasons: NotCoveredReason[]) => [...new Set(reasons.map((reason) => SHORTFALLS[reason]))]

export type FollowupResult =
  // Best S/N ≥ 5: at a distance the visits tell apart, or along the straight line (distance null).
  | { kind: 'signal'; snr: number; visits: number; distance_au: number | null; global: Significance | null }
  // Best S/N ≥ 5, but at every visit the tested distances lie within one aperture.
  | { kind: 'undetermined'; snr: number; visits: number }
  | { kind: 'nothing'; snr: number; visits: number }
  // No hypothesis with usable flux from two visits: `measured` of the `total` visits in the window gave a flux.
  | { kind: 'notCovered'; measured: number; total: number; line: boolean; reasons: string[] }

/** The outcome in the backend's terms: best, significant, distance_determined, the hypotheses and the checks. */
export function followupResult(followup: Followup): FollowupResult {
  const best = followup.best == null ? null : followup.hypotheses[followup.best]
  if (best?.snr == null) {
    return {
      kind: 'notCovered',
      measured: followup.visits_measured,
      total: followup.visits_total,
      line: followup.hypotheses.every((h) => h.distance_au == null),
      reasons: shortfalls(followup.not_covered_reasons),
    }
  }
  const { snr, visits, distance_au } = best
  if (!followup.significant) return { kind: 'nothing', snr, visits }
  if (distance_au != null && !followup.distance_determined) return { kind: 'undetermined', snr, visits }
  return { kind: 'signal', snr, visits, distance_au, global: distance_au == null ? null : globalSignificance(followup) }
}

export const visitsText = (n: number) => `${n} ${n === 1 ? 'visit' : 'visits'}`
const CANDIDATE = 'a candidate to check'

/** The result in one line, first in the panel. */
export function followupResultText(result: FollowupResult): string {
  switch (result.kind) {
    case 'signal': {
      const where = result.distance_au == null ? 'along the straight line' : `at ${num(result.distance_au, 2)} AU`
      const global = result.global ? ` (${result.global.sigma.toFixed(1)}σ after ${result.global.trials} independent distances)` : ''
      return `Follow-up: S/N ${result.snr.toFixed(1)} ${where} in ${visitsText(result.visits)}${global} – ${CANDIDATE}`
    }
    case 'undetermined':
      return `Follow-up: distance undetermined – visits too close in time to the marks; S/N ${result.snr.toFixed(1)} in ${visitsText(result.visits)}, ${CANDIDATE}`
    case 'nothing':
      return `Follow-up: no significant flux along the track in ${visitsText(result.visits)} (best S/N ${result.snr.toFixed(1)})`
    case 'notCovered': {
      const covered = result.total === 0 ? 'no other visit in the window'
        : result.measured === 0 ? `no flux in ${visitsText(result.total)}`
        : `flux in ${result.measured} of ${visitsText(result.total)}, too few ${result.line ? 'to stack' : 'at any one distance'}`
      return `Follow-up: not enough visits covered (${covered})${result.reasons.length > 0 ? ` – ${result.reasons.join(', ')}` : ''}`
    }
  }
}

/** The hypothesis whose visits the details list: the best, else the one with the most usable visits. */
export function shownHypothesis(followup: Followup): FollowupHypothesis | null {
  if (followup.best != null) return followup.hypotheses[followup.best] ?? null
  return followup.hypotheses.reduce<FollowupHypothesis | null>((most, h) => (!most || h.visits > most.visits
    || (h.visits === most.visits && h.measurements.length > most.measurements.length) ? h : most), null)
}

/** What qualifies one visit's flux: why there is none, flagged pixels, an uncertain position. */
export const measurementNotes = (m: FollowupMeasurement) => [
  m.skipped,
  m.flagged ? 'flagged pixels, left out' : null,
  m.position_uncertain ? 'position uncertain' : null,
].filter((note): note is string => !!note)
