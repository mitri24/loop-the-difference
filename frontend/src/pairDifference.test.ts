import { describe, expect, it } from 'vitest'
import {
  changeLine, changeSummary, pairDifferenceRequest, residualMarks, residualText, resultFor, shownChanges, type PairChanges,
} from './pairDifference'
import type { Frame, FrameJob, PairDifference, Residual } from './types'

const frame = (index: number, epoch: number, mjd: number, wavelength: number): Frame => ({
  index, url: `/api/frames/job/frame_${index}.png`, obs_id: `obs-${index}`, date: '2025-05-01T00:00:00Z', mjd, detector: 6,
  wavelength_min_um: 4.4, wavelength_max_um: 5.0, coverage: 1, source_url: 'u', epoch, n_combined: 1, date_end: null,
  masked_fraction: null, wavelength_um: wavelength, bandwidth_um: 0.04,
})

const job = (extra: Partial<FrameJob> = {}, preview = false): FrameJob => ({
  job_id: 'job', status: 'finished', progress: 0, total: 0, error: null,
  manifest: {
    collection: 'spherex_dr1', ra: 0, dec: 0, size_deg: 0.2, detector: 6, pixel_scale_arcsec: 6.15, epochs: 2, complete: true,
    stacked: false, preview, frames: [frame(0, 0, 60800, 4.7), frame(1, 0, 60800.1, 4.9), frame(2, 1, 61170, 4.7)],
    warnings: [], checks: [], differences: [],
  },
  ...extra,
})

const residual = (significance: number, kind: Residual['kind'], known: string | null = null): Residual => ({
  x: 1, y: 2, ra: 10.5, dec: -7.25, significance, kind, known, explanation: '',
})

const result = (extra: Partial<PairDifference> = {}): PairDifference => ({
  job_id: 'job', a: 0, b: 2, comparable: true, reason: null, method: 'zogy', significance_url: 's', difference_url: 'd',
  delta_days: 370, delta_lambda_pct: 0.1, small_bodies_checked: true, residuals: [], checks: [], ...extra,
})

const done = (difference: PairDifference): PairChanges => ({ pair: { a: difference.a, b: difference.b }, status: 'done', result: difference, error: null })

describe('pairDifferenceRequest', () => {
  it('asks for the pair of a finished job, with a small-body lookup once it is finished', () => {
    expect(pairDifferenceRequest(job(), { a: 2, b: 0 })).toEqual({ job_id: 'job', a: 2, b: 0, small_bodies_job: null })
    expect(pairDifferenceRequest(job(), { a: 0, b: 2 }, { job_id: 'sb', status: 'started' })?.small_bodies_job).toBeNull()
    expect(pairDifferenceRequest(job(), { a: 0, b: 2 }, { job_id: 'sb', status: 'finished' })?.small_bodies_job).toBe('sb')
  })

  it('takes the pair the player opens with while it is not shown', () => {
    expect(pairDifferenceRequest(job(), null)).toMatchObject({ a: 0, b: 2 })
  })

  it('waits for final images and two different frames of this job', () => {
    expect(pairDifferenceRequest(null, { a: 0, b: 2 })).toBeNull()
    expect(pairDifferenceRequest(job({ status: 'started' }), { a: 0, b: 2 })).toBeNull()
    expect(pairDifferenceRequest(job({}, true), { a: 0, b: 2 })).toBeNull()
    expect(pairDifferenceRequest(job(), { a: 1, b: 1 })).toBeNull()
    expect(pairDifferenceRequest(job(), { a: 0, b: 3 })).toBeNull()
    const single = job()
    single.manifest!.frames = single.manifest!.frames.slice(0, 1)
    expect(pairDifferenceRequest(single, null)).toBeNull()
  })
})

describe('resultFor and shownChanges', () => {
  it('takes a result only for the same job, A and B', () => {
    const found = result()
    expect(resultFor(found, 'job', { a: 0, b: 2 })).toBe(found)
    expect(resultFor(found, 'job', { a: 2, b: 0 })).toBeNull()
    expect(resultFor(found, 'other', { a: 0, b: 2 })).toBeNull()
    expect(resultFor(found, 'job', null)).toBeNull()
  })

  it('drops a stale pair at once, but keeps the same pair on screen while it is looked up again', () => {
    const last = done(result())
    const again = { job_id: 'job', a: 0, b: 2, small_bodies_job: 'sb' }
    expect(shownChanges(last, again, true)).toBe(last)
    expect(shownChanges(last, again, false)).toEqual(last)
    expect(shownChanges(last, { ...again, b: 1 }, false)).toEqual({ pair: { a: 0, b: 1 }, status: 'loading', result: null, error: null })
    expect(shownChanges(last, null, false).status).toBe('idle')
  })
})

describe('changeSummary and changeLine', () => {
  const loading: PairChanges = { pair: { a: 0, b: 2 }, status: 'loading', result: null, error: null }
  const failed: PairChanges = { pair: { a: 0, b: 2 }, status: 'failed', result: null, error: 'Job queue is not available' }

  it('names how many changes there are and what they are, the result first', () => {
    const many = result({ residuals: [residual(-6, 'unknown'), residual(9, 'asteroid', 'Eros'), residual(5.5, 'unknown'),
      residual(7, 'bright_star', 'Gaia DR3 1'), residual(8, 'known_star', 'AllWISE J1'), residual(6, 'known_star', 'Gaia DR3 2')] })
    expect(changeSummary(done(many))).toBe(
      '6 changes ≥ 5σ between A and B: 1 known asteroid, 2 known stars, 1 near a bright star, 2 need verification')
    expect(changeSummary(done(result({ residuals: [residual(9, 'asteroid', 'Eros'), residual(-7, 'asteroid', 'Eros'),
      residual(6, 'unknown')] })))).toBe('3 changes ≥ 5σ between A and B: 2 known asteroids, 1 needs verification')
    expect(changeLine(done(many))).toBe('6 changes ≥ 5σ')
  })

  it('says so when nothing changed, why a pair does not compare, while it looks and when it failed', () => {
    expect(changeSummary(done(result()))).toBe('No change ≥ 5σ between A and B')
    expect(changeLine(done(result()))).toBe('No change ≥ 5σ')
    const blocked = done(result({ comparable: false, reason: 'A and B were observed at different wavelengths (Δλ 2.2 %)' }))
    expect(changeSummary(blocked)).toBe('Not comparable: A and B were observed at different wavelengths (Δλ 2.2 %)')
    expect(changeLine(blocked)).toBe(changeSummary(blocked))
    expect(changeSummary(loading)).toBe('Finding changes between A and B…')
    expect(changeLine(loading)).toBe('Finding changes between A and B…')
    expect(changeSummary(failed)).toBe('The change search failed: Job queue is not available')
    expect(changeLine(failed)).toBe('The change search failed: Job queue is not available')
    expect(changeLine({ pair: null, status: 'idle', result: null, error: null })).toBeNull()
  })
})

describe('residualMarks', () => {
  const found = result({ residuals: [residual(-6.24, 'asteroid', '(433) Eros'), residual(7.5, 'unknown')] })

  it('marks every change on A and on B, with its σ and class in the title', () => {
    for (const shown of [0, 2]) {
      expect(residualMarks(found, 'job', { a: 0, b: 2 }, shown)).toEqual([
        { ra: 10.5, dec: -7.25, kind: 'residual', name: 'Change −6.2σ · brighter in A · known asteroid (433) Eros' },
        { ra: 10.5, dec: -7.25, kind: 'residual', name: 'Change +7.5σ · brighter in B · needs verification' },
      ])
    }
  })

  it('leaves them out on other frames and for any other pair or job', () => {
    expect(residualMarks(found, 'job', { a: 0, b: 2 }, 1)).toEqual([])
    expect(residualMarks(found, 'job', { a: 2, b: 0 }, 0)).toEqual([])
    expect(residualMarks(found, 'other', { a: 0, b: 2 }, 0)).toEqual([])
    expect(residualMarks(null, 'job', { a: 0, b: 2 }, 0)).toEqual([])
  })

  it('writes the class of a known star and of a bright star', () => {
    expect(residualText(residual(5.04, 'known_star', 'AllWISE J1'))).toBe('+5.0σ · brighter in B · known star AllWISE J1')
    expect(residualText(residual(-8, 'bright_star', 'Gaia DR3 9'))).toBe('−8.0σ · brighter in A · near a bright star Gaia DR3 9')
  })
})
