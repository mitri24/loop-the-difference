// One parameter set for comparing frames: the blink pipeline (backend), the analysis service and the
// UI's epoch axis share resolving power, wavelength tolerance and epoch gap. The Python sources are
// read as text, so the check runs without Python.
import { describe, expect, it } from 'vitest'
import comparabilityPy from '../../analysis-service/app/comparability.py?raw'
import configPy from '../../analysis-service/app/config.py?raw'
import spectralPy from '../../analysis-service/app/spectral.py?raw'
import archivePy from '../../backend/app/archive.py?raw'
import framesPy from '../../backend/app/frames.py?raw'
import { R_BY_DETECTOR, WAVELENGTH_MATCH_FRACTION } from './spectral'
import { EPOCH_GAP_DAYS } from './timeAxis'

// The number assigned to a constant or a typed settings field, whatever the spacing.
function assigned(source: string, name: string): number {
  const match = source.match(new RegExp(`^\\s*${name}\\s*(?::[^=\\n]*)?=\\s*([\\d.]+)`, 'm'))
  if (!match) throw new Error(`${name} not found`)
  return Number(match[1])
}

// Backend: R_BY_DETECTOR = {1: 39, ...}, on one line or several.
function backendR(source: string): Record<string, number> {
  const body = source.match(/^R_BY_DETECTOR\s*=\s*\{([^}]*)\}/m)?.[1] ?? ''
  return Object.fromEntries([...body.matchAll(/(\d+)\s*:\s*([\d.]+)/g)].map(([, d, r]) => [d, Number(r)]))
}

// Analysis service: BandInfo("D1", 1, 0.75, 1.09, 39, "SWIR"), R is the fifth argument.
function serviceR(source: string): Record<string, number> {
  const bands = source.matchAll(/BandInfo\(\s*"D\d"\s*,\s*(\d+)\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)/g)
  return Object.fromEntries([...bands].map(([, d, r]) => [d, Number(r)]))
}

describe('one parameter set for comparing frames', () => {
  it('has the same resolving power per detector in backend and analysis service', () => {
    const r = backendR(framesPy)
    expect(Object.keys(r)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(serviceR(spectralPy)).toEqual(r)
  })

  it('has the same resolving power per detector in the UI (compatible pair, brightness window)', () => {
    expect(Object.fromEntries(Object.entries(R_BY_DETECTOR).map(([d, r]) => [d, r]))).toEqual(backendR(framesPy))
  })

  it('matches wavelengths within the same share of λ/R and stops at the same limit', () => {
    expect(assigned(configPy, 'wavelength_match_fraction')).toBe(assigned(framesPy, 'WAVELENGTH_MATCH_FRACTION'))
    expect(WAVELENGTH_MATCH_FRACTION).toBe(assigned(framesPy, 'WAVELENGTH_MATCH_FRACTION'))
    expect(assigned(comparabilityPy, 'WAVELENGTH_LIMIT_FRACTION')).toBe(assigned(framesPy, 'WAVELENGTH_LIMIT_FRACTION'))
  })

  it('starts a new epoch after the same gap in backend, analysis service and UI', () => {
    expect(assigned(archivePy, 'EPOCH_GAP_DAYS')).toBe(EPOCH_GAP_DAYS)
    expect(assigned(configPy, 'visit_gap_days')).toBe(EPOCH_GAP_DAYS)
  })
})
