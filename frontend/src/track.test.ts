import { describe, expect, it } from 'vitest'
import { candidateState, type Mark } from './candidate'
import { checkFrames, fitTrack, possibleTrack, predict, regime, searchRadius, trackEvidence } from './track'
import type { DetectedSource, Frame } from './types'

const mark = (mjd: number, ra: number, dec: number, sigma = 1): Mark => ({
  obs_id: `obs-${mjd}`, mjd, date: '', ra, dec, sigma_arcsec: sigma,
})
// Pluto, live-measured detections (integration stack job 92596e5d3b332664); S/N 122 and 91 → σ 1″.
const PLUTO_CENTRE = { ra: 308.5283, dec: -22.8925 }
const FRAME_7 = mark(61155.913413, 308.523308, -22.890191)
const FRAME_8 = { mjd: 61156.323055, ra: 308.525431, dec: -22.891551 }
const FRAME_10 = mark(61157.882123, 308.533543, -22.894745)
const FRAME_11_MJD = 61172.96

const sepArcsec = (a: { ra: number; dec: number }, b: { ra: number; dec: number }) => {
  const dRa = ((a.ra - b.ra + 540) % 360) - 180
  return Math.hypot(dRa * Math.cos((a.dec * Math.PI) / 180), a.dec - b.dec) * 3600
}
// A star moving due north: arcsec over days, from (ra, dec).
const northward = (ra: number, dec: number, arcsec: number, days: number, sigma: number) => [
  mark(60000, ra, dec, sigma), mark(60000 + days, ra, dec + arcsec / 3600, sigma),
]

describe('possible track', () => {
  it('fits Pluto frames 7 and 10: 19.15″/day towards PA 116°, a Solar System body is possible', () => {
    const fit = fitTrack([FRAME_7, FRAME_10], PLUTO_CENTRE)!
    expect(fit.rate).toBeCloseTo(19.15, 1)
    expect(fit.sigmaRate).toBeCloseTo(0.72, 2)
    expect(fit.rate / 24).toBeCloseTo(0.798, 2)
    expect(fit.pa).toBeCloseTo(116, 0)
    expect(fit.rmsArcsec).toBeNull()
    expect(regime(fit, [FRAME_7, FRAME_10])).toBe('fast')
  })

  it('predicts Pluto at frame 8 within 2″ and makes no prediction beyond one day after the last mark', () => {
    const track = possibleTrack([FRAME_7, FRAME_10], PLUTO_CENTRE, [FRAME_7.mjd, FRAME_8.mjd, FRAME_10.mjd, FRAME_11_MJD])!
    expect(track.predictions.map((p) => p.mjd)).toEqual([FRAME_7.mjd, FRAME_8.mjd, FRAME_10.mjd])
    expect(sepArcsec(track.predictions[1], FRAME_8)).toBeLessThan(2)
    expect(candidateState(trackEvidence(track))).toBe('motion')
  })

  it('grows the 2σ search area away from the marks', () => {
    const fit = fitTrack([FRAME_7, FRAME_10], PLUTO_CENTRE)!
    const atMean = predict(fit, fit.tMean).radius_arcsec
    expect(atMean).toBeCloseTo(2 / Math.SQRT2, 6)
    expect(predict(fit, FRAME_10.mjd + 1).radius_arcsec).toBeGreaterThan(predict(fit, FRAME_10.mjd).radius_arcsec)
  })

  it('calls an 8″/yr star over 365 days with σ 1″ stellar and predicts at every frame', () => {
    const marks = northward(150, 20, 8, 365, 1)
    const track = possibleTrack(marks, { ra: 150, dec: 20 }, [59000, 60000, 60365, 61000])!
    expect(track.regime).toBe('stellar')
    expect(track.predictions).toHaveLength(4)
    expect(track.fit.rate * 365.25).toBeCloseTo(8, 1)
    expect(track.fit.pa).toBeCloseTo(0, 3)
  })

  it('finds no significant motion for 5″ over 180 days with σ 6″ and draws nothing', () => {
    const track = possibleTrack(northward(150, 20, 5, 180, 6), { ra: 150, dec: 20 }, [60000, 60180])!
    expect(track.regime).toBe('none')
    expect(track.predictions).toEqual([])
    expect(candidateState(trackEvidence(track))).toBe('unverified')
  })

  it('keeps significant motion within one epoch in the ±1 day window', () => {
    const track = possibleTrack(northward(150, 20, 4.4, 30, 1), { ra: 150, dec: 20 }, [59000, 60000, 60030, 61000])!
    expect(track.regime).toBe('fast')
    expect(track.predictions.map((p) => p.mjd)).toEqual([60000, 60030])
  })

  it('makes no straight-line prediction for fast motion across epochs', () => {
    const track = possibleTrack(northward(150, 20, 600, 180, 1), { ra: 150, dec: 20 }, [60000, 60180])!
    expect(track.regime).toBe('solarSystem')
    expect(track.predictions).toEqual([])
  })

  it('fits across RA 0/360 in the tangent plane', () => {
    const cosDec = Math.cos((10 * Math.PI) / 180)
    const marks = [mark(60000, 359.999, 10), mark(60001, 0.001, 10)]
    const fit = fitTrack(marks, { ra: 0, dec: 10 })!
    expect(fit.rate).toBeCloseTo(7.2 * cosDec, 2)
    expect(fit.pa).toBeCloseTo(90, 1)
    const p = predict(fit, 60000.5)
    expect(p.ra < 0.0001 || p.ra > 359.9999).toBe(true)
  })

  it('shrinks σ with a third mark and reports the residual rms', () => {
    const two = fitTrack([mark(60000, 150, 20), mark(60001, 150, 20 + 10 / 3600)], { ra: 150, dec: 20 })!
    const three = fitTrack(
      [mark(60000, 150, 20), mark(60000.5, 150, 20 + 5.6 / 3600), mark(60001, 150, 20 + 10 / 3600)],
      { ra: 150, dec: 20 },
    )!
    expect(three.sigmaRate).toBeLessThanOrEqual(two.sigmaRate)
    expect(predict(three, 60002).radius_arcsec).toBeLessThan(predict(two, 60002).radius_arcsec)
    expect(three.rmsArcsec).toBeGreaterThan(0)
  })

  it('adds the model error to the 2σ search radius and keeps the 1.5-pixel floor', () => {
    expect(searchRadius(3, 6.15)).toBeCloseTo(9.225, 6)
    expect(searchRadius(3, 6.15, 10)).toBe(13)
    expect(searchRadius(3, 6.15, 2)).toBeCloseTo(9.225, 6)
  })

  it('needs two different dates', () => {
    expect(fitTrack([FRAME_7], PLUTO_CENTRE)).toBeNull()
  })
})

const source = (ra: number, dec: number, snr: number): DetectedSource => ({
  ra, dec, x: 0, y: 0, peak_mjy_sr: 1, snr, match: 'none', catalog_id: null, separation_arcsec: null, catalog_mag: null, catalog_band: null,
})
const frame = (obs_id: string, mjd: number, sources?: DetectedSource[]) => ({ obs_id, mjd, date: '2026-05-01T00:00:00Z', sources }) as Frame
const PLUTO_GRID = { ...PLUTO_CENTRE, size_deg: 0.1, pixel_scale_arcsec: 6.15 }

describe('look back within SPHEREx', () => {
  const marks = [{ ...FRAME_7, obs_id: 'f7' }, { ...FRAME_10, obs_id: 'f10' }]
  const check = (frames: Frame[], grid = PLUTO_GRID) => {
    const track = possibleTrack(marks, PLUTO_CENTRE, frames.map((f) => f.mjd))!
    return checkFrames(track, frames, marks, grid)
  }

  it('reads Pluto in frame 8 as a detection near the prediction and skips the marked frames', () => {
    const rows = check([
      frame('f10', FRAME_10.mjd, []), frame('f8', FRAME_8.mjd, [source(308.6, -22.9, 40), source(FRAME_8.ra, FRAME_8.dec, 177)]),
      frame('f7', FRAME_7.mjd, []),
    ])
    expect(rows.map((r) => r.frame.obs_id)).toEqual(['f8'])
    expect(rows[0].index).toBe(1)
    expect(rows[0].result.kind).toBe('detection')
    expect(rows[0].result.kind === 'detection' && rows[0].result.source.snr).toBe(177)
    expect(rows[0].radius_arcsec).toBeCloseTo(1.5 * 6.15, 6)
  })

  it('reports nothing, outside the frame, outside the window and no source list, in time order', () => {
    const rows = check([
      frame('f11', FRAME_11_MJD, []), frame('f7', FRAME_7.mjd), frame('f8', FRAME_8.mjd, [source(308.6, -22.9, 40)]),
      frame('f10', FRAME_10.mjd), frame('f9', 61157, undefined),
    ])
    expect(rows.map((r) => [r.frame.obs_id, r.result.kind])).toEqual([['f8', 'nothing'], ['f9', 'noSources'], ['f11', 'window']])
    expect(rows[2].prediction).toBeNull()
    const outside = check([frame('f7', FRAME_7.mjd), frame('f8', FRAME_8.mjd, []), frame('f10', FRAME_10.mjd)], { ...PLUTO_GRID, ra: 309, size_deg: 0.05 })
    expect(outside[0].result.kind).toBe('outside')
  })
})
