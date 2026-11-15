import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDistantTrack } from './api'
import type { Mark } from './candidate'
import {
  MAX_TARGETS, TRACK_WINDOW_DAYS, checkDistant, distanceGrid, distanceRanges, distantState, farthestAu, labelTime, isCurrent,
  outsideRanges, planDistantTrack, summarizeDistant, useDistantTrack, type DistantField, type DistantPlan, type DistantRow,
} from './distantTrack'
import { possibleTrack, type PossibleTrack } from './track'
import type { DetectedSource, DistantTrack, Frame } from './types'

const mark = (obs_id: string, mjd: number, ra: number, dec: number, sigma = 1): Mark => ({
  obs_id, mjd, date: '', ra, dec, sigma_arcsec: sigma,
})
const frame = (obs_id: string, mjd: number, sources?: DetectedSource[]) =>
  ({ obs_id, mjd, date: '2026-05-28T00:00:00Z', coverage: 1, sources }) as Frame
const source = (ra: number, dec: number, match: DetectedSource['match'] = 'none', snr = 45): DetectedSource => ({
  ra, dec, x: 0, y: 0, peak_mjy_sr: 1, snr, match, catalog_id: null, separation_arcsec: null, catalog_mag: null, catalog_band: null,
})

// Pluto, frames 7 and 10 of the live stack job in track.test.ts: 19.15 ± 0.72″/day within one epoch, at 35.49 AU.
const PLUTO = { ra: 308.5283, dec: -22.8925 }
const A = mark('f7', 61155.913413, 308.523308, -22.890191)
const B = mark('f10', 61157.882123, 308.533543, -22.894745)
const pluto = (mjds: number[]) => possibleTrack([A, B], PLUTO, [A.mjd, B.mjd, ...mjds])!
// 720″/day within half a day: far too fast for 20 AU.
const FAST = [mark('a', 60000, 150, 20), mark('b', 60000.5, 150, 20 + 360 / 3600)]
// 600″ north in 180 days, σ 1″: not a straight line for a star, so if one object it is in the Solar System.
const ACROSS = [mark('a', 60000, 150, 20), mark('b', 60180, 150, 20 + 600 / 3600)]
const across = (mjds: number[], marks = ACROSS) => possibleTrack(marks, { ra: 150, dec: 20 }, [...marks.map((m) => m.mjd), ...mjds])!

describe('distant-object track request', () => {
  it('asks for the other images beyond a day of Pluto’s marks, within 400 days, up to the distance its motion allows', () => {
    const frames = [
      frame('f7', A.mjd), frame('f8', 61156.323055), frame('f10', B.mjd), frame('f10b', B.mjd + 0.6),
      frame('later', 61172.95538), frame('earlier', 60957.00611), frame('old', 60700),
    ]
    const track = pluto(frames.map((f) => f.mjd))
    const plan = planDistantTrack(track, [A, B], frames)!
    expect(plan.frames.map((f) => [f.frame.obs_id, f.skip])).toEqual([['old', 'tooFar'], ['earlier', null], ['later', null]])
    expect(plan.blocked).toBeNull()
    expect(plan.request).toMatchObject({
      marks: [
        { ra: '308.523308', dec: '-22.890191', mjd: A.mjd, sigma_arcsec: 1 },
        { ra: '308.533543', dec: '-22.894745', mjd: B.mjd, sigma_arcsec: 1 },
      ],
      target_mjds: [60957.00611, 61172.95538],
      d_min_au: 20, steps: 64,
    })
    // 19.15 − 3 × 0.72″/day: no bound object beyond about 280 AU moves this fast; Pluto's 35.49 AU stays inside.
    expect(plan.request!.d_max_au).toBeCloseTo(4700 / (track.fit.rate - 3 * track.fit.sigmaRate), 6)
    expect(plan.request!.d_max_au).toBeGreaterThan(250)
    expect(plan.request!.d_max_au).toBeLessThan(300)
  })

  it('allows 2000 AU for slow motion and nothing beyond 20 AU from 235″/day', () => {
    expect(farthestAu(2)).toBe(2000)
    expect(farthestAu(-1)).toBe(2000)
    expect(farthestAu(235)).toBe(20)
    expect(farthestAu(47)).toBe(100)
  })

  it('keeps the 24 times nearest to a mark and names the rest', () => {
    const after = Array.from({ length: 20 }, (_, k) => frame(`a${k}`, B.mjd + 2 + k))
    const before = Array.from({ length: 10 }, (_, k) => frame(`b${k}`, A.mjd - 2 - k))
    const frames = [...after, ...before]
    const plan = planDistantTrack(pluto(frames.map((f) => f.mjd)), [A, B], frames)!
    expect(plan.request!.target_mjds).toHaveLength(MAX_TARGETS)
    expect(plan.frames.filter((f) => f.skip === 'overLimit').map((f) => f.frame.obs_id)).toEqual(['a14', 'a15', 'a16', 'a17', 'a18', 'a19'])
    expect(plan.request!.target_mjds).toEqual([...plan.request!.target_mjds].sort((a, b) => a - b))
  })

  it('asks for marks of different epochs too, up to the distance their mean rate allows', () => {
    const track = across([60090, 60500])
    expect(track.regime).toBe('solarSystem')
    const frames = [frame('a', 60000), frame('mid', 60090), frame('b', 60180), frame('late', 60500)]
    const plan = planDistantTrack(track, ACROSS, frames)!
    expect(plan.frames.map((f) => [f.frame.obs_id, f.skip])).toEqual([['mid', null], ['late', 'tooFar']])
    expect(plan.request).toMatchObject({ target_mjds: [60090], d_min_au: 20, steps: 64, marks: [{ mjd: 60000 }, { mjd: 60180 }] })
    // 3.33″/day on average over half a year: no bound object beyond about 1420 AU gets that far.
    expect(plan.request!.d_max_au).toBeCloseTo(4700 / (track.fit.rate - 3 * track.fit.sigmaRate), 6)
    expect(plan.request!.d_max_au).toBeLessThan(1500)
  })

  it('names marks more than 400 days apart instead of asking, as the API would refuse them', () => {
    const year = [mark('a', 60000, 150, 20), mark('b', 60000 + TRACK_WINDOW_DAYS + 1, 150, 20 + 600 / 3600)]
    expect(planDistantTrack(across([60200], year), year, [frame('mid', 60200)])).toMatchObject({ blocked: 'marksTooFar', request: null })
    const edge = [year[0], { ...year[1], mjd: 60000 + TRACK_WINDOW_DAYS }]
    expect(distanceGrid(across([], edge), edge)).toMatchObject({ grid: { d_min_au: 20 } })
  })

  it('asks nothing without significant motion, for a star, a single mark, or when the straight line covers every other image', () => {
    const star = [mark('a', 60000, 150, 20), mark('b', 60365, 150, 20 + 8 / 3600)]
    expect(across([], star).regime).toBe('stellar')
    expect(distanceGrid(across([], star), star)).toBeNull()
    const still = [mark('a', 60000, 150, 20, 6), mark('b', 60180, 150, 20 + 5 / 3600, 6)]
    expect(distanceGrid(across([], still), still)).toBeNull()
    expect(planDistantTrack(pluto([]), [A], [frame('later', 61172.95538)])).toBeNull()
    expect(planDistantTrack(null, [A, B], [frame('later', 61172.95538)])).toBeNull()
    expect(planDistantTrack(pluto([61156.3]), [A, B], [frame('f8', 61156.3)])).toBeNull()
  })

  it('names motion too fast for 20 AU and marks closer than the API takes instead of asking', () => {
    const fast = planDistantTrack(possibleTrack(FAST, { ra: 150, dec: 20 }, [60000, 60000.5, 60010])!, FAST, [frame('c', 60010)])!
    expect(fast).toMatchObject({ blocked: 'tooFast', request: null })
    const close = [mark('a', 60000, 150, 20), mark('b', 60000.0008, 150, 20)]
    const track = { regime: 'fast', fit: { rate: 10, sigmaRate: 1 } } as PossibleTrack
    expect(planDistantTrack(track, close, [frame('c', 60010)])).toMatchObject({ blocked: 'marksTooClose', request: null })
  })

})

// Five assumed distances; at each target time the positions run east in steps of 0.01°.
const DISTANCES = [20, 25, 40, 100, 2000]
const GRID = { ra: 150, dec: 20, size_deg: 0.2, pixel_scale_arcsec: 6.15 }
const T = { fits: 61172, outside: 60957, nothing: 61175, noSources: 61180 }
const positionsAt = (mjd: number, ra0: number, radius = 3) => DISTANCES.map((_, i) => ({ mjd, ra: ra0 + 0.01 * i, dec: 20, radius_arcsec: radius }))
const DISTANT: DistantTrack = {
  model: 'straight-line heliocentric motion + Earth parallax',
  assumptions: ['Each hypothesis is one assumed distance from Earth at the first mark, not an orbit.'],
  hypotheses: DISTANCES.map((distance_au, i) => ({
    distance_au,
    points: [positionsAt(T.fits, 149.98), positionsAt(T.outside, 152), positionsAt(T.nothing, 149.98), positionsAt(T.noSources, 149.98)]
      .map((points) => points[i]),
  })),
}
const at = (i: number) => ({ ra: 149.98 + 0.01 * i, dec: 20 })
const plan = (frames: Frame[], skip: DistantPlan['frames'][number]['skip'] = null): DistantPlan => ({
  frames: frames.map((f) => ({ frame: f, skip })), blocked: null, request: null,
})

describe('distant-object track check', () => {
  it('finds the distances whose search circle (2σ plus the model error, at least 1.5 pixels) holds an uncatalogued detection', () => {
    const sources = [
      source(at(2).ra, at(2).dec + 4 / 3600),
      source(at(1).ra, at(1).dec - 8 / 3600, 'none', 20),
      source(at(3).ra, at(3).dec, 'gaia'),
      source(at(4).ra, at(4).dec, 'allwise'),
    ]
    const [row] = checkDistant(plan([frame('fits', T.fits, sources)]), DISTANT, GRID)
    expect(row.result).toMatchObject({ kind: 'fits', inside: [0, 1, 2, 3, 4], hits: [1, 2], unknown: [] })
    expect(row.result.kind === 'fits' && row.result.nearest.sep_arcsec).toBeCloseTo(4, 3)
    expect(distanceRanges([1, 2], DISTANCES)).toEqual([[25, 40]])
  })

  it('checks only the distances whose position falls in the field and names the rest', () => {
    // Field centre 0.02° west of the 20 AU position, 0.07° wide: 20 and 25 AU fall inside, 40–2000 AU outside.
    const narrow = { ...GRID, ra: 149.96, size_deg: 0.07 }
    const [row] = checkDistant(plan([frame('fits', T.fits, [source(at(1).ra, at(1).dec + 3 / 3600), source(at(3).ra, at(3).dec)])]), DISTANT, narrow)
    expect(row.result).toMatchObject({ kind: 'fits', inside: [0, 1], hits: [1] })
    expect(outsideRanges([0, 1], DISTANCES)).toEqual([[40, 2000]])
  })

  it('counts a detection without a catalogue answer and marks the hit as unknown', () => {
    const unknownOnly = checkDistant(plan([frame('fits', T.fits, [source(at(2).ra, at(2).dec, 'unknown')])]), DISTANT, GRID)
    expect(unknownOnly[0].result).toMatchObject({ kind: 'fits', hits: [2], unknown: [2] })
    const both = [source(at(2).ra, at(2).dec, 'unknown'), source(at(2).ra, at(2).dec + 5 / 3600)]
    expect(checkDistant(plan([frame('fits', T.fits, both)]), DISTANT, GRID)[0].result).toMatchObject({ hits: [2], unknown: [] })
  })

  it('widens the search circle by the model’s own error', () => {
    const loose: DistantTrack = {
      ...DISTANT, hypotheses: DISTANT.hypotheses.map((h) => ({ ...h, points: h.points.map((p) => ({ ...p, model_error_arcsec: 20 })) })),
    }
    // 15″ north of the 20 AU position: beyond 1.5 pixels (9.2″), inside 2σ (3″) plus the model error (20″).
    const frames = [frame('fits', T.fits, [source(at(0).ra, at(0).dec + 15 / 3600)])]
    expect(checkDistant(plan(frames), DISTANT, GRID)[0].result.kind).toBe('nothing')
    expect(checkDistant(plan(frames), loose, GRID)[0].result).toMatchObject({ kind: 'fits', hits: [0] })
  })

  it('takes a 2σ radius larger than the pixel floor from the prediction', () => {
    const wide: DistantTrack = { ...DISTANT, hypotheses: DISTANT.hypotheses.map((h) => ({ ...h, points: h.points.map((p) => ({ ...p, radius_arcsec: 30 })) })) }
    const [row] = checkDistant(plan([frame('fits', T.fits, [source(at(0).ra, at(0).dec + 20 / 3600)])]), wide, GRID)
    expect(row.result.kind === 'fits' && row.result.hits).toEqual([0])
  })

  it('names nothing with the nearest detection, positions off the field, a missing source list and skipped times', () => {
    const far = source(at(0).ra, at(0).dec + 100 / 3600, 'none', 12)
    const rows = checkDistant(plan([frame('outside', T.outside, []), frame('nothing', T.nothing, [far]), frame('noSources', T.noSources)]), DISTANT, GRID)
    expect(rows.map((r) => r.result.kind)).toEqual(['outside', 'nothing', 'noSources'])
    expect(rows[0].result.kind === 'outside' && rows[0].result.offset_deg).toBeCloseTo(2 * Math.cos((20 * Math.PI) / 180), 3)
    expect(rows[1].result.kind === 'nothing' && rows[1].result.nearest?.sep_arcsec).toBeCloseTo(100, 3)
    const empty = checkDistant(plan([frame('nothing', T.nothing, [source(at(0).ra, at(0).dec, 'gaia')])]), DISTANT, GRID)
    expect(empty[0].result).toEqual({ kind: 'nothing', inside: [0, 1, 2, 3, 4], nearest: null })
    expect(checkDistant(plan([frame('old', 60000)], 'tooFar'), null, GRID)[0].result).toEqual({ kind: 'tooFar' })
  })
})

const ALL = [0, 1, 2, 3, 4]
const nearest = { source: source(0, 0), sep_arcsec: 2 }
const row = (result: DistantRow['result'], mjd = 0): DistantRow => ({ frame: frame(`x${mjd}`, mjd), result })
const fits = (hits: number[], inside = ALL, unknown: number[] = [], mjd = 0) => row({ kind: 'fits', inside, hits, unknown, nearest }, mjd)

describe('distant-object track summary', () => {
  it('reports the distances that fit in the most images, the images checked and those off the field', () => {
    const rows = [
      fits([1, 2]), fits([2, 3]), row({ kind: 'nothing', inside: ALL, nearest: null }),
      row({ kind: 'outside', offset_deg: 1.5 }), row({ kind: 'outside', offset_deg: 0.8 }), row({ kind: 'noSources' }),
    ]
    expect(summarizeDistant(rows, DISTANCES)).toEqual({ kind: 'fits', ranges: [[40, 40]], images: 2, checked: 3, outside: 2, unknownOnly: false })
  })

  it('counts each distance only over the images in which its position fell in the field', () => {
    // 25 AU: a detection in the first image, missed in the second. 100 AU: outside the first image's field, a detection in the second.
    const rows = [fits([1], [0, 1]), fits([3])]
    expect(summarizeDistant(rows, DISTANCES)).toEqual({ kind: 'fits', ranges: [[100, 100]], images: 1, checked: 1, outside: 1, unknownOnly: false })
  })

  it('keeps separate distance ranges that fit equally often apart and flags hits without a catalogue answer', () => {
    expect(summarizeDistant([fits([0]), fits([3, 4])], DISTANCES)).toMatchObject({ ranges: [[20, 20], [100, 2000]], images: 1, checked: 2 })
    expect(summarizeDistant([fits([2], ALL, [2])], DISTANCES)).toMatchObject({ ranges: [[40, 40]], unknownOnly: true })
    expect(summarizeDistant([fits([2], ALL, [2]), fits([2])], DISTANCES)).toMatchObject({ images: 2, unknownOnly: false })
  })

  it('tells nothing found from positions off the field and from nothing checkable', () => {
    expect(summarizeDistant([row({ kind: 'nothing', inside: ALL, nearest }), row({ kind: 'outside', offset_deg: 1 })], DISTANCES))
      .toEqual({ kind: 'nothing', checked: 1, outside: 1 })
    expect(summarizeDistant([row({ kind: 'outside', offset_deg: 1.5 }), row({ kind: 'outside', offset_deg: 0.8 })], DISTANCES))
      .toEqual({ kind: 'outside', offset_deg: 0.8 })
    expect(summarizeDistant([row({ kind: 'noSources' }), row({ kind: 'tooFar' })], [])).toEqual({ kind: 'unchecked' })
  })
})

describe('distant-object track labels on the sky', () => {
  it('labels the image farthest in time from the marks among those in the field, else among all predicted', () => {
    const marks = [{ mjd: 100 }, { mjd: 101 }]
    const rows = [fits([1], ALL, [], 80), row({ kind: 'nothing', inside: ALL, nearest: null }, 120), row({ kind: 'outside', offset_deg: 1 }, 300)]
    expect(labelTime(rows, marks)).toBe(80)
    expect(labelTime([row({ kind: 'outside', offset_deg: 1 }, 110), row({ kind: 'outside', offset_deg: 1 }, 300), row({ kind: 'tooFar' }, 600)], marks)).toBe(300)
    expect(labelTime([row({ kind: 'tooFar' }, 600)], marks)).toBeNull()
  })
})

describe('distant-object track state', () => {
  const ask = planDistantTrack(pluto([61172.95538]), [A, B], [frame('later', 61172.95538)])!
  const key = JSON.stringify(ask.request)

  it('takes only the answer to the current marks and attempt', () => {
    const answer = { key, attempt: 1, track: DISTANT }
    expect(isCurrent(answer, key, 1)).toBe(true)
    expect(isCurrent(answer, 'other marks', 1)).toBe(false)
    expect(isCurrent(answer, key, 2)).toBe(false)
  })

  it('waits while the answer is missing or stale, then shows an error or the checked images', () => {
    const range = [20, ask.request!.d_max_au]
    const stale = { key: 'old marks', attempt: 0, track: DISTANT }
    expect(distantState(ask, key, isCurrent(stale, key, 0) ? stale : null, [])).toMatchObject({ status: 'loading', range })
    expect(distantState(ask, key, { key, attempt: 0, error: 'Request failed (422)' }, [])).toMatchObject({ status: 'error', error: 'Request failed (422)' })
    const ready = distantState(ask, key, { key, attempt: 0, track: DISTANT }, [fits([2])])
    expect(ready).toMatchObject({ status: 'ready', track: DISTANT, summary: { kind: 'fits', ranges: [[40, 40]] } })
    expect(distantState(null, '', null, []).status).toBe('off')
    expect(distantState({ ...ask, blocked: 'tooFast', request: null }, '', null, []).status).toBe('tooFast')
  })
})

describe('useDistantTrack', () => {
  afterEach(() => vi.unstubAllGlobals())

  const field = (frames: Frame[]): DistantField => ({ ...PLUTO, size_deg: 0.2, pixel_scale_arcsec: 6.15, frames })
  function Probe({ track, marks, frames }: { track: PossibleTrack | null; marks: Mark[]; frames: Frame[] }) {
    const state = useDistantTrack(null, track, marks, field(frames))
    return <>{state.status}</>
  }

  it('waits for the API while two marks of one epoch ask, and stays off or too fast without asking', () => {
    const frames = [frame('later', 61172.95538)]
    expect(renderToStaticMarkup(<Probe track={pluto([61172.95538])} marks={[A, B]} frames={frames} />)).toBe('loading')
    expect(renderToStaticMarkup(<Probe track={across([60090])} marks={ACROSS} frames={[frame('mid', 60090)]} />)).toBe('loading')
    expect(renderToStaticMarkup(<Probe track={pluto([61172.95538])} marks={[A]} frames={frames} />)).toBe('off')
    const track = possibleTrack(FAST, { ra: 150, dec: 20 }, [60000, 60000.5, 60010])
    expect(renderToStaticMarkup(<Probe track={track} marks={FAST} frames={[frame('c', 60010)]} />)).toBe('tooFast')
    // All other images more than 400 days away: nothing to ask, every image named.
    expect(renderToStaticMarkup(<Probe track={pluto([60700])} marks={[A, B]} frames={[frame('old', 60700)]} />)).toBe('ready')
  })

  it('createDistantTrack posts the request and forwards the caller’s abort signal', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(DISTANT), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(await createDistantTrack(ask(), controller.signal)).toEqual(DISTANT)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/track/distant')
    expect(JSON.parse(init.body as string)).toEqual(ask())
    controller.abort()
    expect(init.signal?.aborted).toBe(true)
  })
})

function ask() {
  return planDistantTrack(pluto([61172.95538]), [A, B], [frame('later', 61172.95538)])!.request!
}
