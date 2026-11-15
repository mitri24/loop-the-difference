import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFollowup, getFollowupJob } from './api'
import type { Mark } from './candidate'
import { distanceGrid } from './distantTrack'
import {
  MAX_POINTS, currentRun, followupKind, followupPhase, followupRequest, followupResult, followupResultText, globalSignificance,
  linePoints, progressText, runError, runKey, shortfalls, shownHypothesis, useFollowup, withAnswer, type FollowupField, type FollowupRun,
} from './followup'
import { followupOf as result, hypothesis, measurement } from './followupFixtures'
import { possibleTrack, predict, type PossibleTrack } from './track'
import type { FollowupJob, Frame, Observation } from './types'

const CENTRE = { ra: 150, dec: 20 }
const mark = (obs_id: string, mjd: number, dec: number, sigma = 1): Mark => ({
  obs_id, mjd, date: `${obs_id}-date`, ra: 150, dec, sigma_arcsec: sigma,
})
const frame = (obs_id: string, mjd: number, date: string, date_end: string | null = null) => ({ obs_id, mjd, date, date_end }) as Frame
const track = (marks: Mark[]) => possibleTrack(marks, CENTRE, marks.map((m) => m.mjd))!

// A on a stack of one epoch (its mean time), B on one exposure half a year later: 600″ north, a Solar System body if one object.
const STACK = frame('stackA', 60001, '2025-05-01T10:00:00Z', '2025-05-03T10:00:00Z')
const SINGLE = frame('b', 60180, '2025-10-27T00:00:00Z')
const ACROSS = [mark('stackA', 60001, 20), mark('b', 60180, 20 + 600 / 3600)]
// Within one epoch: 10″ in a day, faster than any star.
const FAST = [mark('f1', 60000, 20), mark('f2', 60001, 20 + 10 / 3600)]
// 8″ in a year with σ 1″: stellar proper motion.
const STAR = [mark('s1', 60000, 20), mark('s2', 60365, 20 + 8 / 3600)]
// 5″ in half a year with σ 6″: no significant motion.
const STILL = [mark('n1', 60000, 20, 6), mark('n2', 60180, 20 + 5 / 3600, 6)]
const field = (frames: Frame[] = [STACK, SINGLE]): FollowupField => ({ ...CENTRE, detector: 3, frames })
const visit = (obs_id: string, mjd: number, detector = 3) => ({ obs_id, mjd, detector }) as Observation

describe('follow-up request', () => {
  it('offers the follow-up only for two marks with a track: distances within or across epochs, the line for a star', () => {
    expect(followupKind(track(ACROSS), ACROSS)).toBe('distances')
    expect(followupKind(track(FAST), FAST)).toBe('distances')
    expect(followupKind(track(STAR), STAR)).toBe('line')
    expect(track(STILL).regime).toBe('none')
    expect(followupKind(track(STILL), STILL)).toBeNull()
    expect(followupKind(track(ACROSS), [ACROSS[0]])).toBeNull()
    expect(followupKind(null, ACROSS)).toBeNull()
    // Marks the API refuses: more than 400 days apart, or too fast for 20 AU.
    const year = [ACROSS[0], mark('late', 60402, 20 + 600 / 3600)]
    expect(followupKind(track(year), year)).toBeNull()
    expect(followupKind({ regime: 'fast', fit: { rate: 300, sigmaRate: 1 } } as PossibleTrack, FAST)).toBeNull()
  })

  it('asks for the distant-object track’s distance grid with the marked frames, a stack with its span', () => {
    const request = followupRequest(track(ACROSS), ACROSS, field(), null)!
    expect(request).toEqual({
      ra: '150', dec: '20', detector: 3,
      marked: [
        { obs_id: 'stackA', date: '2025-05-01T10:00:00Z', date_end: '2025-05-03T10:00:00Z' },
        { obs_id: 'b', date: '2025-10-27T00:00:00Z', date_end: null },
      ],
      grid: (distanceGrid(track(ACROSS), ACROSS) as { grid: object }).grid,
    })
    expect(request.grid).toMatchObject({ d_min_au: 20, steps: 64, marks: [{ ra: '150', dec: '20', mjd: 60001, sigma_arcsec: 1 }, { mjd: 60180 }] })
    expect(request.grid!.d_max_au).toBeLessThan(2000)
    expect(request.points).toBeUndefined()
  })

  it('names a mark’s frame by its own time when the frame is not in the field', () => {
    expect(followupRequest(track(FAST), FAST, field([]), null)!.marked).toEqual([
      { obs_id: 'f1', date: 'f1-date', date_end: null }, { obs_id: 'f2', date: 'f2-date', date_end: null },
    ])
  })

  it('asks for the straight line of a star once per visit time of the detector, and waits for the archive’s visits', () => {
    const star = track(STAR)
    const visits = [visit('v1', 60100), visit('v1-qr3', 60100), visit('v2', 60200), visit('other detector', 60150, 4)]
    const request = followupRequest(star, STAR, field(), visits)!
    expect(request.grid).toBeUndefined()
    expect(request.points).toEqual([60100, 60200].map((mjd) => {
      const { ra, dec, radius_arcsec } = predict(star.fit, mjd)
      return { mjd, ra, dec, radius_arcsec }
    }))
    expect(followupRequest(star, STAR, field(), null)).toBeNull()
    expect(followupRequest(star, STAR, field(), [visit('other detector', 60150, 4)])).toBeNull()
  })

  it('keeps at most 1000 straight-line positions, spread over every visit', () => {
    const many = Array.from({ length: 2500 }, (_, k) => visit(`v${k}`, 60000 + k / 10))
    const points = linePoints(track(STAR), many, 3)
    expect(points).toHaveLength(MAX_POINTS)
    expect([points[0].mjd, points.at(-1)!.mjd]).toEqual([60000, 60249.9])
  })
})

const job = (status: FollowupJob['status'], change: Partial<FollowupJob> = {}): FollowupJob => ({
  job_id: 'abc', status, progress: 0, total: 0, followup: null, error: null, ...change,
})
const run = (change: Partial<FollowupRun> = {}): FollowupRun => ({
  key: 'marks', attempt: 1, request: followupRequest(track(ACROSS), ACROSS, field(), null), job: null, error: null, ...change,
})

describe('follow-up run', () => {
  it('belongs to its marks: new marks drop it, so its polling stops and the button shows again', () => {
    const key = runKey(ACROSS, field(), 'distances')
    expect(runKey([ACROSS[0], { ...ACROSS[1], dec: 20.2 }], field(), 'distances')).not.toBe(key)
    expect(runKey(ACROSS, { ...field(), detector: 4 }, 'distances')).not.toBe(key)
    const started = run({ key, job: job('started') })
    expect(currentRun(started, key)).toBe(started)
    expect(currentRun(started, 'other marks')).toBeNull()
    expect(currentRun(started, '')).toBeNull()
    expect(followupPhase(currentRun(started, 'other marks'))).toBe('idle')
  })

  it('takes an answer only for its marks and attempt; a late one is dropped', () => {
    const sending = run()
    expect(withAnswer(sending, 'marks', 1, { job: job('queued') }).job?.status).toBe('queued')
    expect(withAnswer(sending, 'other marks', 1, { job: job('queued') })).toBe(sending)
    expect(withAnswer(sending, 'marks', 0, { error: 'late' })).toBe(sending)
  })

  it('reads sending, running, done and the errors from the request and the job', () => {
    expect(followupPhase(run())).toBe('sending')
    expect(followupPhase(run({ job: job('queued') }))).toBe('running')
    expect(followupPhase(run({ job: job('started') }))).toBe('running')
    expect(followupPhase(run({ job: job('finished', { followup: result({}) }) }))).toBe('done')
    expect(followupPhase(run({ request: null }))).toBe('idle')
    expect(runError(run({ error: 'The data service timed out. Retry in a moment.' }))).toBe('The data service timed out. Retry in a moment.')
    expect(runError(run({ job: job('failed', { error: 'SPHEREx archive (IRSA) is not reachable' }) }))).toBe('SPHEREx archive (IRSA) is not reachable')
    expect(runError(run({ job: job('not_found') }))).toBe('The follow-up job expired.')
    expect(runError(run({ job: job('started') }))).toBeNull()
  })

  it('shows progress as cutouts loaded of all planned', () => {
    expect(progressText(null)).toBe('Follow-up: starting…')
    expect(progressText(job('queued'))).toBe('Follow-up: waiting for a free worker…')
    expect(progressText(job('started'))).toBe('Follow-up: searching the archive for visits…')
    expect(progressText(job('started', { progress: 12, total: 40 }))).toBe('Follow-up: 12 of 40 cutouts…')
  })
})

const GRID = [hypothesis(20, 1.2, 6), hypothesis(40, 2.1, 6), hypothesis(307.6, 7.24, 6), hypothesis(2000, 0.4, 5)]

describe('follow-up result line', () => {
  it('names the S/N, the distance and the visits of a signal, with the look-elsewhere correction, as a candidate', () => {
    const found = result({ best: 2, significant: true, distance_determined: true, hypotheses: GRID, global_sigma: 4.1, independent_trials: 12 })
    expect(followupResult(found)).toEqual({ kind: 'signal', snr: 7.24, visits: 6, distance_au: 307.6, global: { sigma: 4.1, trials: 12 } })
    expect(followupResultText(followupResult(found)))
      .toBe('Follow-up: S/N 7.2 at 310 AU in 6 visits (4.1σ after 12 independent distances) – a candidate to check')
  })

  it('names no distance for a straight line, nor when the visits cannot tell the distances apart', () => {
    const line = result({ best: 0, significant: true, hypotheses: [hypothesis(null, 6.31, 3)], model: 'straight line through the marks' })
    expect(followupResultText(followupResult(line))).toBe('Follow-up: S/N 6.3 along the straight line in 3 visits – a candidate to check')
    const open = result({ best: 2, significant: true, distance_determined: false, hypotheses: GRID.map((h) => ({ ...h, snr: 6, visits: 4 })) })
    expect(followupResultText(followupResult(open)))
      .toBe('Follow-up: distance undetermined – visits too close in time to the marks; S/N 6.0 in 4 visits, a candidate to check')
  })

  it('says no significant flux with the best S/N, without naming a distance for noise', () => {
    const noise = result({ best: 1, significant: false, distance_determined: true, hypotheses: GRID.map((h) => ({ ...h, visits: 9 })) })
    expect(followupResultText(followupResult(noise))).toBe('Follow-up: no significant flux along the track in 9 visits (best S/N 2.1)')
  })

  it('says how many visits gave a flux, of how many in the window, and why the rest did not', () => {
    const few = result({
      hypotheses: [hypothesis(20, 3, 1, [measurement('v1'), measurement('v2', { flagged: true })]), hypothesis(40, null, 0, [measurement('v2', { flagged: true })])],
      visits_total: 5, visits_measured: 2, not_covered_reasons: ['outside_image', 'flagged_pixels'],
    })
    expect(followupResult(few)).toEqual({ kind: 'notCovered', measured: 2, total: 5, line: false, reasons: ['positions outside the images', 'flagged pixels'] })
    expect(followupResultText(followupResult(few)))
      .toBe('Follow-up: not enough visits covered (flux in 2 of 5 visits, too few at any one distance) – positions outside the images, flagged pixels')
    const line = result({ hypotheses: [hypothesis(null, null, 1)], visits_total: 3, visits_measured: 1, not_covered_reasons: ['cutout_missing'] })
    expect(followupResultText(followupResult(line)))
      .toBe('Follow-up: not enough visits covered (flux in 1 of 3 visits, too few to stack) – cutouts not delivered')
    const none = result({ hypotheses: [hypothesis(20, null, 0), hypothesis(2000, null, 0)], visits_total: 4,
      not_covered_reasons: ['search_circle_too_wide', 'model_error_too_large'] })
    expect(followupResultText(followupResult(none))).toBe('Follow-up: not enough visits covered (no flux in 4 visits) – positions too uncertain')
    expect(followupResultText(followupResult(result({ not_covered_reasons: ['beyond_window'] }))))
      .toBe('Follow-up: not enough visits covered (no other visit in the window) – other visits more than 400 days from the marks')
  })

  it('corrects for the tried distances only when there was more than one', () => {
    expect(globalSignificance(result({ global_sigma: 4.1, independent_trials: 12 }))).toEqual({ sigma: 4.1, trials: 12 })
    expect(globalSignificance(result({ global_sigma: 7.2, independent_trials: 1 }))).toBeNull()
    expect(globalSignificance(result({ global_sigma: null, independent_trials: 0 }))).toBeNull()
    expect(shortfalls(['thinned', 'release_unavailable', 'thinned'])).toEqual(['visits left out for the 48-cutout budget', 'a SPHEREx release not searchable'])
  })

  it('lists the visits of the best hypothesis, else of the one with the most usable visits', () => {
    expect(shownHypothesis(result({ best: 2, hypotheses: GRID }))).toBe(GRID[2])
    const two = hypothesis(40, null, 1, [measurement('v1'), measurement('v2')])
    expect(shownHypothesis(result({ hypotheses: [hypothesis(20, null, 1, [measurement('v1')]), two] }))).toBe(two)
    expect(shownHypothesis(result({}))).toBeNull()
  })
})

describe('useFollowup', () => {
  afterEach(() => vi.unstubAllGlobals())

  function Probe({ marks, field: at = field() }: { marks: Mark[]; field?: FollowupField | null }) {
    const state = useFollowup(marks.length > 1 ? track(marks) : null, marks, at)
    return <>{`${state.kind ?? 'off'} ${state.phase} ${state.ready(null)}`}</>
  }

  it('waits for the button: nothing is asked by itself, and nothing is offered without a track', () => {
    expect(renderToStaticMarkup(<Probe marks={ACROSS} />)).toBe('distances idle true')
    expect(renderToStaticMarkup(<Probe marks={STAR} />)).toBe('line idle false')
    expect(renderToStaticMarkup(<Probe marks={STILL} />)).toBe('off idle false')
    expect(renderToStaticMarkup(<Probe marks={[ACROSS[0]]} />)).toBe('off idle false')
    expect(renderToStaticMarkup(<Probe marks={ACROSS} field={null} />)).toBe('off idle false')
  })

  it('createFollowup posts the request and getFollowupJob polls by id, both with the caller’s abort signal', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(job('queued')), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const body = followupRequest(track(ACROSS), ACROSS, field(), null)!
    expect(await createFollowup(body, controller.signal)).toEqual(job('queued'))
    expect(await getFollowupJob('abc', controller.signal)).toEqual(job('queued'))
    const [[postUrl, post], [getUrl, get]] = fetch.mock.calls as unknown as [string, RequestInit][]
    expect([postUrl, post.method, JSON.parse(post.body as string)]).toEqual(['/api/followup', 'POST', body])
    expect(getUrl).toBe('/api/followup/abc')
    controller.abort()
    expect([post.signal?.aborted, get.signal?.aborted]).toEqual([true, true])
  })
})
