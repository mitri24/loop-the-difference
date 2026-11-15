import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_STATES, OUTSIDE_FRAME, VERDICTS, addMark, candidateState, insideFrame, markText, placeLinkMarks, sigmaFor, snapMark,
  type Mark,
} from './candidate'
import { NOT_LISTED, NOT_REACHABLE } from './knownObjects'
import type { DetectedSource, Frame } from './types'

const SCALE = 6.15 // arcsec per pixel: snap radius 12.3″
const source = (ra: number, dec: number, snr: number): DetectedSource => ({
  ra, dec, x: 0, y: 0, peak_mjy_sr: 1, snr, match: 'none', catalog_id: null,
  separation_arcsec: null, catalog_mag: null, catalog_band: null,
})
const frame = (obs_id: string, mjd: number, sources?: DetectedSource[]) =>
  ({ obs_id, mjd, date: '2026-04-25T21:55:12Z', sources }) as Frame
const mark = (obs_id: string, mjd: number): Mark =>
  ({ obs_id, mjd, date: '2026-04-25T21:55:12Z', ra: 1, dec: 2, sigma_arcsec: 3 })

describe('snapMark', () => {
  const dec = 60 // RA offsets shrink by cos(dec) = 0.5
  const near = source(10 + (2 * 12 / 3600), dec, 122) // 12″ on the sky
  const far = source(10, dec + 12.5 / 3600, 50)

  it('takes the nearest detection within two pixels with its σ', () => {
    const m = snapMark(frame('f1', 61000, [far, near]), 10, dec, SCALE)
    expect(m.source).toBe(near)
    expect([m.ra, m.dec, m.sigma_arcsec]).toEqual([near.ra, dec, 1])
  })

  it('keeps the click with σ 3″ when nothing lies within 12.3″', () => {
    const m = snapMark(frame('f1', 61000, [far]), 10, dec, SCALE)
    expect(m.source).toBeUndefined()
    expect([m.ra, m.dec, m.sigma_arcsec]).toEqual([10, dec, 3])
    expect(markText(m, 'A')).toBe('A · 2026-04-25 21:55 UTC · RA 10.00000° Dec 60.00000° ± 3.0″ · position as clicked')
    expect(snapMark(frame('f1', 61000), 10, dec, SCALE).source).toBeUndefined()
  })

  it('snaps across RA 0/360', () => {
    const wrapped = source(0.001, 10, 50)
    expect(snapMark(frame('f1', 61000, [wrapped]), 359.999, 10, SCALE).source).toBe(wrapped)
  })

  it('writes the evidence of a snapped mark', () => {
    const m = snapMark(frame('f1', 61000, [source(308.52331, -22.89019, 122)]), 308.5233, -22.8902, SCALE)
    expect(markText(m, 'A')).toBe(
      'A · 2026-04-25 21:55 UTC · RA 308.52331° Dec −22.89019° ± 1.0″ · × No catalogue match – needs verification (S/N 122)')
  })
})

it('σ per axis follows S/N', () => {
  expect([null, 5, 19.9, 20, 299, 300].map(sigmaFor)).toEqual([3, 1.5, 1.5, 1, 1, 6])
})

it('insideFrame accepts the corners and refuses just outside', () => {
  const m = { ra: 308.5, dec: -22.9, size_deg: 0.2 }
  const ra = (east: number) => m.ra + east / Math.cos((m.dec * Math.PI) / 180)
  expect(insideFrame(m.ra, m.dec, m)).toBe(true)
  expect(insideFrame(ra(0.0999), m.dec + 0.0999, m)).toBe(true)
  expect(insideFrame(ra(-0.0999), m.dec - 0.0999, m)).toBe(true)
  expect(insideFrame(ra(0.101), m.dec, m)).toBe(false)
  expect(insideFrame(m.ra, m.dec - 0.101, m)).toBe(false)
  expect(OUTSIDE_FRAME).toBe('Click inside the SPHEREx frame (blue outline)')
})

describe('addMark', () => {
  const add = (marks: Mark[], m: Mark) => {
    const r = addMark(marks, m)
    if ('error' in r) throw new Error(r.error)
    return r.marks
  }

  it('sorts A before B, replaces a re-marked frame and stops at two', () => {
    const two = add(add([], mark('late', 61100)), mark('early', 61000))
    expect(two.map((m) => m.obs_id)).toEqual(['early', 'late'])
    const replaced = add(two, { ...mark('late', 61100), ra: 5 })
    expect(replaced.map((m) => m.ra)).toEqual([1, 5])
    expect(addMark(two, mark('third', 61200))).toEqual({ error: 'Two marks are set. Clear marks to start again.' })
  })

  it('refuses frames less than 60 s apart', () => {
    const one = add([], mark('a', 61000))
    expect(addMark(one, mark('b', 61000 + 59 / 86400))).toEqual({
      error: 'This frame is less than 60 s from mark A: choose a frame from another time.',
    })
    expect(add(one, mark('b', 61000 + 61 / 86400))).toHaveLength(2)
  })
})

it('candidate state precedence: known body > catalogue star (unless fast) > motion > brightness', () => {
  expect(candidateState({})).toBe('unverified')
  expect(candidateState({ brightness: true })).toBe('brightness')
  expect(candidateState({ motion: true, brightness: true })).toBe('motion')
  expect(candidateState({ catalogueStar: true, motion: true })).toBe('catalogueStar')
  expect(candidateState({ catalogueStar: true, fastMotion: true })).toBe('motion')
  expect(candidateState({ knownBody: true, catalogueStar: true })).toBe('knownBody')
  expect(`${CANDIDATE_STATES.unverified.icon} ${CANDIDATE_STATES.unverified.word}`)
    .toBe('? Unverified candidate – needs verification')
})

it('no state or verdict claims a result', () => {
  const words = [...Object.values(CANDIDATE_STATES).map((s) => s.word), ...VERDICTS, NOT_LISTED, NOT_REACHABLE]
  for (const word of words) expect(word).not.toMatch(/\b(confirmed|real|discovery|new object)\b/i)
})

describe('placeLinkMarks', () => {
  const detection = source(10.002, 60, 122)
  const manifest = { pixel_scale_arcsec: SCALE, frames: [frame('a', 61000, [detection]), frame('b', 61001), frame('c', 61000.0001)] }

  it('finds the detection again and keeps a clicked position, A the earlier', () => {
    const { marks, missing } = placeLinkMarks(manifest, [{ obs_id: 'b', ra: 10.01, dec: 60 }, { obs_id: 'a', ra: 10.002, dec: 60 }])
    expect(missing).toBe(0)
    expect(marks.map((m) => m.obs_id)).toEqual(['a', 'b'])
    expect(marks[0].source).toBe(detection)
    expect(marks[1]).toMatchObject({ ra: 10.01, dec: 60, sigma_arcsec: 3 })
    expect(marks[1].source).toBeUndefined()
  })

  it('counts marks whose frame is not in this comparison or that break the rules', () => {
    expect(placeLinkMarks(manifest, [{ obs_id: 'x', ra: 10, dec: 60 }, { obs_id: 'a', ra: 10, dec: 60 }]))
      .toMatchObject({ missing: 1, marks: [{ obs_id: 'a' }] })
    // c is less than a minute after a: the second mark is refused, as a click would be.
    expect(placeLinkMarks(manifest, [{ obs_id: 'a', ra: 10, dec: 60 }, { obs_id: 'c', ra: 10, dec: 60 }]).missing).toBe(1)
  })
})
