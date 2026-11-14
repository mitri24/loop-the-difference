import { describe, expect, it } from 'vitest'
import { candidateState, type Mark } from './candidate'
import { fitTrack, possibleTrack, predict, regime, trackEvidence } from './track'

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

  it('needs two different dates', () => {
    expect(fitTrack([FRAME_7], PLUTO_CENTRE)).toBeNull()
  })
})
