import { describe, expect, it } from 'vitest'
import { bandText, BANDS, fitContinuum, readBand, readBands } from './bands'
import type { SpectrumPoint } from './types'

const point = (wavelength_um: number, flux_ujy: number, over: Partial<SpectrumPoint> = {}): SpectrumPoint => ({
  obs_id: `o${wavelength_um}`, date: '2026-01-01T00:00:00', mjd: 61000, detector: 4, epoch: 0,
  wavelength_um, bandwidth_um: 0.08, flux_ujy, flux_err_ujy: 2, source_url: '#', ...over,
})

// A flat 100 µJy spectrum from 2.5 to 5 µm every 0.05 µm, with an optional dip around one band.
function spectrum(dip?: { at: number; half: number; depth: number }) {
  const points: SpectrumPoint[] = []
  for (let lam = 2.5; lam <= 5.0; lam += 0.05) {
    const inDip = dip && Math.abs(lam - dip.at) <= dip.half
    points.push(point(+lam.toFixed(3), inDip ? 100 * (1 - dip.depth) : 100))
  }
  return points
}
const ch4 = BANDS.find((b) => b.id === 'ch4')!

describe('molecular bands', () => {
  it('reads a 20 % dip at 3.32 µm as a significant CH₄-consistent dip', () => {
    const r = readBand(spectrum({ at: 3.325, half: 0.08, depth: 0.2 }), ch4)
    expect(r.status).toBe('dip')
    expect(r.depth).toBeCloseTo(0.2, 2)
    expect(r.sigma!).toBeGreaterThanOrEqual(3)
    expect(bandText(r)).toMatch(/^CH₄ 3.32 µm: dip 20 % ± \d+ % \(.*σ\) – consistent with CH₄ absorption, needs verification$/)
  })

  it('finds no significant dip in a flat spectrum', () => {
    const readings = readBands(spectrum())
    expect(readings.every((r) => r.status === 'none')).toBe(true)
    expect(bandText(readings[0])).toContain('no significant dip')
  })

  it('says "not measurable" without clean points on both sides, and "saturated" when flagged points dominate', () => {
    const noRight = spectrum().filter((p) => p.wavelength_um < 3.6)
    expect(readBand(noRight, ch4).status).toBe('notMeasurable')
    const sky = spectrum().map((p) => ({ ...p, flux_ujy: p.wavelength_um * 10 % 3 - 1 }))
    expect(readBand(sky, ch4).status).toBe('noContinuum') // empty sky: no flux to read a dip against
    const flagged = spectrum().map((p) => (p.wavelength_um >= 3.25 && p.wavelength_um <= 3.4 ? { ...p, flagged: true } : p))
    expect(readBand(flagged, ch4).status).toBe('saturated')
  })

  it('reads no dip on a smooth stellar continuum (Rayleigh–Jeans, F ∝ λ⁻²) at 1 % errors', () => {
    const star = spectrum().map((p) => ({ ...p, flux_ujy: 1000 * (2.5 / p.wavelength_um) ** 2, flux_err_ujy: 10 * (2.5 / p.wavelength_um) ** 2 }))
    for (const r of readBands(star)) expect([r.band.id, r.status]).toEqual([r.band.id, 'none'])
  })

  it('keeps false dips rare on noisy flat spectra of faint sources (S/N 1, 2 and 10 per point)', () => {
    // Seeded Gaussian noise (mulberry32 + Box–Muller): the same 1000 readings every run.
    let t = 7
    const uniform = () => {
      t = (t + 0x6d2b79f5) >>> 0
      let r = Math.imul(t ^ (t >>> 15), 1 | t)
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
      return (((r ^ (r >>> 14)) >>> 0) + 0.5) / 4294967296
    }
    const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
    for (const snr of [1, 2, 10]) {
      let dips = 0
      for (let n = 0; n < 200; n++) {
        const noisy = spectrum().map((p) => ({ ...p, flux_err_ujy: 100 / snr, flux_ujy: 100 + (100 / snr) * gauss() }))
        dips += readBands(noisy).filter((r) => r.status === 'dip').length
      }
      // One-sided 3σ: about 1–2 false dips per 1000 readings expected.
      expect([snr, dips]).toEqual([snr, expect.any(Number)])
      expect(dips).toBeLessThanOrEqual(10)
    }
  })

  it('warns that CH₄ and CH₃OH lie in the wing of a broad H₂O ice band', () => {
    const broad = spectrum().map((p) => (p.wavelength_um >= 2.9 && p.wavelength_um <= 3.6 ? { ...p, flux_ujy: 70 } : p))
    const readings = readBands(broad)
    expect(readings.find((r) => r.band.id === 'h2o')!.status).toBe('dip')
    expect(bandText(readings.find((r) => r.band.id === 'ch4')!)).toContain('inside the wing of the H₂O band')
  })

  it('ignores a flagged outlier in the continuum and warns when the continuum scatters', () => {
    const outlier = spectrum().map((p) => (p.wavelength_um === 2.7 ? { ...p, flux_ujy: 5, flagged: true } : p))
    expect(readBand(outlier, ch4).status).toBe('none')
    const noisy = spectrum().map((p, i) => ({ ...p, flux_ujy: p.flux_ujy + (i % 2 ? 30 : -30) }))
    expect(readBand(noisy, ch4).noisyContinuum).toBe(true)
  })

  it('fits a power-law continuum and its error at the band centre', () => {
    const law = [2.7, 2.8, 3.7, 3.8].map((l) => point(l, 500 * (3 / l) ** 2))
    expect(fitContinuum(law, 3.32)!.value).toBeCloseTo(500 * (3 / 3.32) ** 2, 6)
    const sloped = [2.7, 2.8, 3.7, 3.8].map((l) => point(l, 50 + 10 * l))
    const fit = fitContinuum(sloped, 3.32)!
    expect(fit.value).toBeCloseTo(50 + 33.2, 0) // a power law through a gentle straight line
    expect(fit.variance).toBeGreaterThan(0)
    expect(fitContinuum([point(3, 1)], 3)).toBeNull()
  })

  it('never claims a detection', () => {
    for (const r of readBands(spectrum({ at: 3.05, half: 0.1, depth: 0.3 }))) {
      expect(bandText(r)).not.toMatch(/contains|detected|brown dwarf|discover/i)
    }
  })
})
