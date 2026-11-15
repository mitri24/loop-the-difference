import { describe, expect, it } from 'vitest'
import { distantTrackShapes } from './trackLayer'
import type { DistantTrack } from './types'

// The API's default grid: 64 distances from 20 to 2000 AU, uniform in 1/d.
const GRID_AU = Array.from({ length: 64 }, (_, k) => 1 / (1 / 20 - (k * (1 / 20 - 1 / 2000)) / 63))
// SPHEREx pixels of 6.15″: the search radius is at least 1.5 of them.
const PIXEL = 6.15
const FLOOR = 1.5 * PIXEL
const track = (distances: number[], mjds: number[]): DistantTrack => ({
  model: 'straight-line heliocentric motion + Earth parallax',
  assumptions: [],
  hypotheses: distances.map((distance_au, i) => ({
    distance_au,
    points: mjds.map((mjd, j) => ({ mjd, ra: 150 + j + 0.001 * i, dec: 20 - 0.001 * i, radius_arcsec: 5 + 10 * j })),
  })),
})

describe('distant-object track on the sky', () => {
  it('draws one line per image through every assumed distance, 20 AU first', () => {
    const { lines } = distantTrackShapes(track(GRID_AU, [61172, 60957]), null, PIXEL)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveLength(64)
    expect(lines[1][0]).toEqual([151, 20])
    expect(lines[1][63][0]).toBeCloseTo(151.063, 6)
  })

  it('puts search circles near 20, 40, 100 and 2000 AU on every image, as wide as the check counts', () => {
    const { circles } = distantTrackShapes(track(GRID_AU, [61172, 60957]), null, PIXEL)
    expect(circles).toHaveLength(8)
    expect(circles[1].distance_au).toBeCloseTo(40.23, 2)
    expect(circles[1].ra).toBeCloseTo(150.032, 6)
    expect(circles[2].distance_au).toBeCloseTo(100.72, 2)
    expect(circles[3].distance_au).toBeCloseTo(2000, 6)
    // 2σ of 5″ is below the 1.5-pixel floor; 15″ is not.
    expect(circles.map((c) => c.radius_arcsec)).toEqual([FLOOR, FLOOR, FLOOR, FLOOR, 15, 15, 15, 15])
  })

  it('labels the distances on one image only', () => {
    const { labels } = distantTrackShapes(track(GRID_AU, [61172, 60957]), 60957, PIXEL)
    expect(labels.map((l) => [l.label, l.mjd])).toEqual([['20 AU', 60957], ['40 AU', 60957], ['100 AU', 60957], ['2000 AU', 60957]])
    expect(distantTrackShapes(track(GRID_AU, [61172]), null, PIXEL).labels).toEqual([])
  })

  it('draws a circle once when two labels share the nearest distance, and nothing without hypotheses', () => {
    const { labels } = distantTrackShapes(track([35.49, 36.49], [61172]), 61172, PIXEL)
    expect(labels.map((l) => l.label)).toEqual(['35 AU', '36 AU'])
    expect(distantTrackShapes(track([], [61172]), 61172, PIXEL)).toEqual({ lines: [], circles: [], labels: [] })
  })
})
