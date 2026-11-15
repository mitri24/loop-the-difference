import { describe, expect, it } from 'vitest'
import {
  buildSourceMap, checkFirst, featuresOf, groupSources, isolationScores, MIN_UMAP_SOURCES, pca2, standardise,
} from './sourceMap'
import type { DetectedSource } from './types'

const PIX = 6.15
const RA0 = 120
const DEC0 = 10
const FRAMES = 6

function source(over: Partial<DetectedSource>): DetectedSource {
  return {
    ra: RA0, dec: DEC0, x: 0, y: 0, peak_mjy_sr: 1, snr: 20, match: 'gaia',
    catalog_id: null, separation_arcsec: 0.5, catalog_mag: null, catalog_band: null, ...over,
  }
}

// `stars` ordinary Gaia stars in every frame, one fast mover without a match (a new place each frame), and one
// steady source without Gaia but bright in AllWISE (very red against its SPHEREx brightness).
function field(stars: number) {
  return Array.from({ length: FRAMES }, (_, f) => ({
    sources: [
      ...Array.from({ length: stars }, (_, i) => source({
        ra: RA0 + i * 0.01, dec: DEC0, catalog_id: `Gaia DR3 ${i}`, catalog_band: 'G',
        // A cloud of ordinary stars: fainter stars have fainter G, the colour stays the same.
        peak_mjy_sr: 0.5 + (i % 7) * 0.2 * (1 + 0.01 * f), catalog_mag: 15 - 2.5 * Math.log10(0.5 + (i % 7) * 0.2),
      })),
      source({ ra: RA0 + 0.5, dec: DEC0 + f * 0.01, match: 'none', catalog_id: null, separation_arcsec: null, peak_mjy_sr: 1.2 }),
      source({ ra: RA0 + 0.7, dec: DEC0 + 0.2, match: 'allwise', catalog_id: 'AllWISE J1', catalog_band: 'W1', catalog_mag: 6.0, peak_mjy_sr: 0.6 }),
    ],
  }))
}

describe('source map', () => {
  it('groups a catalogue source by its id and an unmatched mover into one group per position', () => {
    const groups = groupSources(field(3), PIX)
    expect(groups.find((g) => g.key === 'Gaia DR3 0')?.detections).toHaveLength(FRAMES)
    // 0.01° = 36″ per frame, far beyond 1.5 px: the mover shows up as one short-lived group per frame.
    expect(groups.filter((g) => g.match === 'none')).toHaveLength(FRAMES)
    expect(groups.find((g) => g.key === 'AllWISE J1')?.detections).toHaveLength(FRAMES)
  })

  it('keeps a star in one group when its catalogue failed for one frame', () => {
    const frames = field(MIN_UMAP_SOURCES + 10)
    frames[FRAMES - 1].sources = frames[FRAMES - 1].sources.map((s) =>
      s.catalog_id?.startsWith('Gaia') ? { ...s, match: 'unknown' as const, catalog_id: null, catalog_mag: null, catalog_band: null } : s)
    const groups = groupSources(frames, PIX)
    expect(groups.find((g) => g.key === 'Gaia DR3 3')?.detections).toHaveLength(FRAMES)
    // The ordinary stars stay out of "check first"; the mover and the red source lead it.
    const top = checkFirst(buildSourceMap(frames, PIX), FRAMES + 1).map((p) => p.group.match)
    expect(top.filter((m) => m === 'gaia')).toHaveLength(0)
  })

  it('measures presence, scatter and colour, and leaves unmeasurable features empty', () => {
    const groups = groupSources(field(3), PIX)
    const mover = featuresOf(groups.find((g) => g.match === 'none')!, FRAMES)
    expect(mover[2]).toBeCloseTo(1 / FRAMES) // seen in one frame only, at S/N 20
    const faint = groupSources([{ sources: [source({ match: 'none', catalog_id: null, snr: 6 })] }, { sources: [] }], PIX)[0]
    expect(featuresOf(faint, 2)[2]).toBeNull() // at the detection limit, missing frames say nothing
    expect(mover[1]).toBeNull() // no brightness scatter from one detection
    expect(mover[6]).toBeNull() // no Gaia magnitude, so no SPHEREx − G colour
    const red = featuresOf(groups.find((g) => g.key === 'AllWISE J1')!, FRAMES)
    expect(red[4]).toBe(0)
    expect(red[5]).toBe(1)
    expect(red[7]).toBeCloseTo(-2.5 * Math.log10(0.6) - 6.0)
  })

  it('puts the mover and the red source without Gaia at the top of "check first"', () => {
    const map = buildSourceMap(field(MIN_UMAP_SOURCES + 10), PIX)
    expect(map.method).toBe('umap')
    const top = checkFirst(map, FRAMES + 1).map((p) => p.group.match)
    expect(top).toContain('allwise')
    expect(top.filter((m) => m === 'none').length).toBeGreaterThanOrEqual(FRAMES - 1)
  })

  it('draws the same map for the same field (fixed seed)', () => {
    const a = buildSourceMap(field(MIN_UMAP_SOURCES + 5), PIX)
    const b = buildSourceMap(field(MIN_UMAP_SOURCES + 5), PIX)
    expect(a.points.map((p) => [p.u, p.v])).toEqual(b.points.map((p) => [p.u, p.v]))
  })

  it('falls back to a linear projection for few sources and to nothing for fewer than three', () => {
    expect(buildSourceMap(field(5), PIX).method).toBe('pca')
    expect(buildSourceMap([{ sources: [source({ catalog_id: 'a' })] }], PIX)).toMatchObject({ method: 'none', points: [] })
  })

  it('scales robustly and keeps a missing value neutral', () => {
    const z = standardise([[1, null], [2, 5], [3, 7], [100, 6]], [0.1, 0.1])
    expect(z[0][1]).toBe(0)
    expect(Math.abs(z[3][0])).toBeGreaterThan(10) // an outlier stays far out
    // A nearly constant feature: the floor keeps a 0.01 difference from becoming a big distance.
    expect(Math.abs(standardise([[1], [1], [1], [1.01]], [0.25])[3][0])).toBeLessThan(0.1)
    expect(isolationScores([[0, 0], [3, 4]])).toEqual([0, 5])
    const [p] = pca2([[1, 0], [2, 0], [3, 0]])
    expect(Number.isFinite(p[0])).toBe(true)
  })
})
