import { describe, expect, it } from 'vitest'
import { bandOfSlice, isBlankSlice, parseCubeWavelengths, sliceText } from './skyCube'
import { sliceForDetector } from './sky'

// Lines of https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties (2026-11-14)
const PROPERTIES = `hips_cube_depth      = 102
hips_cube_firstframe = 1
data_cube_bunit3     = um
data_cube_crval3_arr = 0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 1.113 1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 1.656 1.695 1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 2.445 2.506 2.575 2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 3.833 3.867 3.901 3.935 3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 4.435 4.467 4.500 4.533 4.566 4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988
moc_sky_fraction     = 1.000000`

describe('SPHEREx all-sky cube slices', () => {
  it('reads one wavelength per slice from the cube metadata', () => {
    const um = parseCubeWavelengths(PROPERTIES)!
    expect(um).toHaveLength(102)
    expect(um[0]).toBe(0.753)
    expect(um[101]).toBe(4.988)
    // The per-detector slices of sky.ts sit at the wavelengths it names.
    expect(um[sliceForDetector(1)]).toBe(0.91)
    expect(um[sliceForDetector(6)]).toBe(4.704)
  })

  it('refuses metadata with a wrong length or unit', () => {
    expect(parseCubeWavelengths(PROPERTIES.replace('= 102', '= 101'))).toBeNull()
    expect(parseCubeWavelengths(PROPERTIES.replace('= um', '= nm'))).toBeNull()
    expect(parseCubeWavelengths('hips_order = 5')).toBeNull()
  })

  it('maps slices to detectors, 17 per band', () => {
    expect(bandOfSlice(0)).toBe(1)
    expect(bandOfSlice(16)).toBe(1)
    expect(bandOfSlice(17)).toBe(2)
    expect(bandOfSlice(101)).toBe(6)
  })

  it('marks the two dichroic channels as blank and counts channels from 1', () => {
    const um = parseCubeWavelengths(PROPERTIES)
    expect([49, 50, 51, 52].map(isBlankSlice)).toEqual([false, true, true, false])
    expect(sliceText(50, um)).toBe('Channel 51 of 102 · D3 · blank (dichroic gap, no data)')
    expect(sliceText(8, um)).toBe('Channel 9 of 102 · D1 · 0.910 µm')
    expect(sliceText(8, null)).toBe('Channel 9 of 102 · D1 · wavelength unknown')
  })
})
