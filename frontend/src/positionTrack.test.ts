import { describe, expect, it } from 'vitest'
import { propagateGaia } from './catalogLayers'
import { FOLLOW_PIXELS, fitMotion, followPosition, offsetArcsec, resultLine } from './positionTrack'
import type { DetectedSource, Frame, ProperMotion } from './types'

const SCALE = 6.15 // arcsec per pixel: the follow radius is 12.3″
const source = (ra: number, dec: number, snr = 50, extra: Partial<DetectedSource> = {}): DetectedSource => ({
  ra, dec, x: 0, y: 0, peak_mjy_sr: 1, snr, match: 'gaia', catalog_id: null,
  separation_arcsec: null, catalog_mag: null, catalog_band: null, ...extra,
})
const frame = (obs_id: string, mjd: number, sources?: DetectedSource[]) =>
  ({ obs_id, mjd, date: '2025-05-01T00:00:00', detector: 6, source_url: `https://irsa.example/${obs_id}`, sources }) as Frame

// A Barnard's-Star-like fast star: 10.4″ per year, mostly north.
const STAR: ProperMotion = {
  source_id: '1', ra: 269.4485, dec: 4.7394, ref_epoch: 2016, pmra_mas_yr: -801.6, pmdec_mas_yr: 10362.4, parallax_mas: 547,
}
const at = (mjd: number) => propagateGaia({ ra: STAR.ra, dec: STAR.dec, pmRa: STAR.pmra_mas_yr, pmDec: STAR.pmdec_mas_yr }, mjd, STAR.ref_epoch)

describe('offsetArcsec', () => {
  it('scales RA by cos δ and wraps it at 0/360', () => {
    expect(offsetArcsec(10, 60, 10 + 2 / 3600, 60).east).toBeCloseTo(1, 9)
    const wrapped = offsetArcsec(359.9999, 0, 0.0001, 0.001)
    expect(wrapped.east).toBeCloseTo(0.72, 6)
    expect(wrapped.north).toBeCloseTo(3.6, 6)
  })
})

describe('followPosition', () => {
  it('follows a star along its Gaia motion, past a neighbour, and measures that motion', () => {
    const mjds = [60800, 60990, 61170, 61350]
    const frames = mjds.map((mjd, i) => {
      const p = at(mjd)
      // A neighbour 8″ east of the star, inside the follow radius: the Gaia prediction picks the star.
      return frame(`f${i}`, mjd, [source(p.ra + 8 / 3600, p.dec), source(p.ra, p.dec, 80)])
    })
    const track = followPosition(frames, { ra: 0, dec: 0 }, SCALE, STAR)
    expect(track.gaps).toEqual([])
    expect(track.points.map((p) => p.source.snr)).toEqual([80, 80, 80, 80])
    for (const p of track.points) {
      expect(p.east).toBeCloseTo(p.predicted!.east, 6)
      expect(p.north).toBeCloseTo(p.predicted!.north, 6)
    }
    expect(track.points.at(-1)!.north).toBeCloseTo(10.3624 * (550 / 365.25), 2)
    expect(track.fit!.total).toBeCloseTo(track.predictedTotal!, 2)
    // 0.6″ per point over 1.5 years: ± 0.54″ per year.
    expect(resultLine(track)).toBe('Shifts 10.4 ± 0.54″ per year in these frames · Gaia DR3 predicts 10.4″ per year')
  })

  it('without a Gaia motion follows the last detection, and names every gap', () => {
    const step = 5 / 3600 // 5″ north per frame: within reach of the last detection; the last one is 15″ from the start
    const frames = [
      frame('a', 60800, [source(150, 2)]),
      frame('b', 60801, [source(150, 2 + step)]),
      frame('old', 60802),
      frame('empty', 60803, []),
      frame('c', 60990, [source(150, 2 + 2 * step)]),
      frame('d', 61170, [source(150, 2 + 3 * step), source(150.01, 2)]),
    ]
    const track = followPosition(frames, { ra: 150, dec: 2 }, SCALE)
    expect(track.points.map((p) => p.frame.obs_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(track.points.map((p) => Math.round(p.north))).toEqual([0, 5, 10, 15])
    expect(track.points.every((p) => p.predicted === null)).toBe(true)
    expect(track.gaps).toEqual([
      { frame: frames[2], reason: 'prepared before source detection existed' },
      { frame: frames[3], reason: `no detection within ${FOLLOW_PIXELS} px (12″) of the expected position` },
    ])
    expect(track.predictedTotal).toBeNull()
  })

  it('gives a saturated core its larger σ and reads a still star as no significant shift', () => {
    const frames = [
      frame('a', 60800, [source(150, 2, 300, { saturated: true })]),
      frame('b', 60990, [source(150, 2 + 0.2 / 3600, 40)]),
      frame('c', 61170, [source(150, 2 - 0.1 / 3600, 40)]),
    ]
    const track = followPosition(frames, { ra: 150, dec: 2 }, SCALE)
    expect(track.points.map((p) => p.sigma)).toEqual([2.5, 0.6, 0.6])
    expect(resultLine(track)).toMatch(/^No significant shift: 0\.\d\d ± \d\.\d\d″ per year$/)
  })

  it('does not fit a motion within one visit or from one frame', () => {
    const sameVisit = followPosition([frame('a', 60800, [source(150, 2)]), frame('b', 60802, [source(150, 2)])], { ra: 150, dec: 2 }, SCALE)
    expect(sameVisit.fit).toBeNull()
    expect(resultLine(sameVisit)).toBe('The frames span 2 days: too short to measure a yearly motion.')
    const single = followPosition([frame('a', 60800, [source(150, 2)]), frame('b', 60990, [])], { ra: 150, dec: 2 }, SCALE)
    expect(single.points).toHaveLength(1)
    expect(fitMotion(single.points)).toBeNull()
    expect(resultLine(single)).toBe('Fewer than two frames have a detection here: no position over time.')
  })

  it('widens the error when the frames scatter more than their bars say', () => {
    const scattered = [0, 3, -3, 3].map((d, i) => frame(`f${i}`, 60800 + 180 * i, [source(150, 2 + d / 3600, 40)]))
    const fit = followPosition(scattered, { ra: 150, dec: 2 }, SCALE).fit!
    // 0.6″ per point over 1.5 years alone would give ±0.5″ per year; the 3″ scatter makes it larger.
    expect(fit.sigmaNorth).toBeGreaterThan(1)
  })
})
