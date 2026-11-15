// The changes between the blink's A and B: found by the worker for every pair the blink shows (backend/app/difference.py),
// shown as one result line, as markers on A and B, and on request as the significance or difference image.
import { useEffect, useState } from 'react'
import { createPairDifference, getPairDifference } from './api'
import { defaultBlinkPair, type BlinkPair } from './blink'
import type { ImageMark } from './components/ImageMarks'
import type { FrameJob, PairDifference, PairDifferenceRequest, Residual, ResidualKind, SmallBodiesJob } from './types'

// A pair the user steps through quickly is not sent; a new pair cancels the one before.
export const DEBOUNCE_MS = 300
export const POLL_MS = 1000

export interface PairChanges {
  pair: BlinkPair | null // the pair the changes are for
  status: 'idle' | 'loading' | 'done' | 'failed'
  result: PairDifference | null
  error: string | null
}

const IDLE: PairChanges = { pair: null, status: 'idle', result: null, error: null }

// Only a finished comparison's final images, and two different frames of it: the player's pair, or the pair it opens
// with while it is not shown (the difference view). A small-body lookup counts once it is finished.
export function pairDifferenceRequest(job: FrameJob | null, pair: BlinkPair | null,
  smallBodies: Pick<SmallBodiesJob, 'job_id' | 'status'> | null = null): PairDifferenceRequest | null {
  const manifest = job?.status === 'finished' ? job.manifest : null
  if (!job || !manifest || manifest.preview || manifest.frames.length < 2) return null
  const shown = pair ?? defaultBlinkPair(manifest.frames)
  const count = manifest.frames.length
  if (!shown || shown.a === shown.b || ![shown.a, shown.b].every((i) => Number.isInteger(i) && i >= 0 && i < count)) return null
  return { job_id: job.job_id, a: shown.a, b: shown.b, small_bodies_job: smallBodies?.status === 'finished' ? smallBodies.job_id : null }
}

// A result stands for the pair on screen only when job, A and B are the same; any other one is stale.
export function resultFor(result: PairDifference | null, jobId: string | null | undefined, pair: BlinkPair | null): PairDifference | null {
  return result && pair && result.job_id === jobId && result.a === pair.a && result.b === pair.b ? result : null
}

// While a pair's changes are looked up again (a small-body lookup finished), its last result stays on screen.
export function shownChanges(last: PairChanges, request: PairDifferenceRequest | null, sameRequest: boolean): PairChanges {
  if (!request) return IDLE
  if (sameRequest) return last
  const pair = { a: request.a, b: request.b }
  const kept = resultFor(last.result, request.job_id, pair)
  return { pair, status: kept ? 'done' : 'loading', result: kept, error: null }
}

export function usePairDifference(job: FrameJob | null, pair: BlinkPair | null,
  smallBodies: Pick<SmallBodiesJob, 'job_id' | 'status'> | null = null): PairChanges {
  const request = pairDifferenceRequest(job, pair, smallBodies)
  const key = request ? `${request.job_id}:${request.a}:${request.b}:${request.small_bodies_job ?? ''}` : ''
  const [state, setState] = useState<{ key: string; changes: PairChanges }>({ key: '', changes: IDLE })
  const jobId = request?.job_id
  const a = request?.a
  const b = request?.b
  const smallBodiesJob = request?.small_bodies_job ?? null

  useEffect(() => {
    if (jobId === undefined || a === undefined || b === undefined) return
    const controller = new AbortController()
    const { signal } = controller
    const pair = { a, b }
    const done = (changes: Omit<PairChanges, 'pair'>) => { if (!signal.aborted) setState({ key, changes: { pair, ...changes } }) }
    const timer = window.setTimeout(async () => {
      try {
        let current = await createPairDifference({ job_id: jobId, a, b, small_bodies_job: smallBodiesJob }, signal)
        while (current.status === 'queued' || current.status === 'started') {
          await new Promise((resolve) => window.setTimeout(resolve, POLL_MS))
          if (signal.aborted) return
          current = await getPairDifference(current.job_id, signal)
        }
        done(current.status === 'finished' && current.difference
          ? { status: 'done', result: current.difference, error: null }
          : { status: 'failed', result: null, error: current.error ?? 'The change search expired: choose the pair again.' })
      } catch (cause) {
        done({ status: 'failed', result: null, error: cause instanceof Error ? cause.message : String(cause) })
      }
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, jobId, a, b, smallBodiesJob])

  return shownChanges(state.changes, request, state.key === key)
}

const KIND_ORDER: ResidualKind[] = ['asteroid', 'known_star', 'bright_star', 'unknown']

function kindCount(kind: ResidualKind, n: number): string {
  if (kind === 'asteroid') return `${n} known ${n === 1 ? 'asteroid' : 'asteroids'}`
  if (kind === 'known_star') return `${n} known ${n === 1 ? 'star' : 'stars'}`
  if (kind === 'bright_star') return `${n} near ${n === 1 ? 'a bright star' : 'bright stars'}`
  return `${n} ${n === 1 ? 'needs' : 'need'} verification`
}

export function changeCount(result: PairDifference): string {
  const n = result.residuals.length
  return n === 0 ? 'No change ≥ 5σ' : `${n} ${n === 1 ? 'change' : 'changes'} ≥ 5σ`
}

// The line under the blink's A/B table: how many changes, or why A and B do not compare; nothing without a pair.
export function changeLine(changes: PairChanges): string | null {
  const { result } = changes
  if (changes.status === 'idle') return null
  if (!result) return changes.status === 'loading' ? 'Finding changes between A and B…' : `The change search failed: ${changes.error ?? 'no answer'}`
  return result.comparable ? changeCount(result) : `Not comparable: ${result.reason ?? 'the checks block this pair'}`
}

// The result first, in one line: how many changes and what they are, why A and B do not compare, or why there is none.
export function changeSummary(changes: PairChanges): string {
  const { result } = changes
  if (changes.status === 'idle') return 'Choose two images as A and B to find their changes.'
  if (changes.status === 'loading' && !result) return 'Finding changes between A and B…'
  if (changes.status === 'failed' || !result) return `The change search failed: ${changes.error ?? 'no answer'}`
  if (!result.comparable) return `Not comparable: ${result.reason ?? 'the checks block this pair'}`
  if (result.residuals.length === 0) return `${changeCount(result)} between A and B`
  const kinds = KIND_ORDER.flatMap((kind) => {
    const n = result.residuals.filter((r) => r.kind === kind).length
    return n > 0 ? [kindCount(kind, n)] : []
  })
  return `${changeCount(result)} between A and B: ${kinds.join(', ')}`
}

const KIND_TEXT: Record<ResidualKind, string> = {
  asteroid: 'known asteroid',
  known_star: 'known star',
  bright_star: 'near a bright star',
  unknown: 'needs verification',
}

export function residualText(residual: Residual): string {
  const s = residual.significance
  const known = residual.known ? ` ${residual.known}` : ''
  return `${s > 0 ? '+' : '−'}${Math.abs(s).toFixed(1)}σ · brighter in ${s > 0 ? 'B' : 'A'} · ${KIND_TEXT[residual.kind]}${known}`
}

// The changes on A and B themselves, only while the player shows exactly the pair they were found for.
export function residualMarks(result: PairDifference | null, jobId: string | null | undefined, pair: BlinkPair | null,
  frameIndex: number): ImageMark[] {
  const shown = resultFor(result, jobId, pair)
  if (!shown || (frameIndex !== shown.a && frameIndex !== shown.b)) return []
  return shown.residuals.map((residual) => ({ ra: residual.ra, dec: residual.dec, kind: 'residual', name: `Change ${residualText(residual)}` }))
}
