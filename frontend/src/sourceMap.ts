// Source map (NAS-83): every source detected in the shown frames as one point on a 2D map.
// What makes a source unusual is measured in the full feature space (isolation score); UMAP, or PCA
// for few sources, only draws the map. Nothing here classifies a source.
import { UMAP } from 'umap-js'
import type { DetectedSource, Frame, SourceMatch } from './types'

// Detections of one unmatched source in different frames lie within this many pixels.
export const GROUP_PIXELS = 1.5
// Below this many sources UMAP has too few neighbours to learn the shape: a linear projection instead.
export const MIN_UMAP_SOURCES = 30
export const SEED = 42
// A source at the 5σ limit comes and goes with the noise: its absence from other frames says nothing.
// Only a source this significant somewhere should have been seen in every frame.
export const PRESENCE_MIN_SNR = 10

export interface SourceGroup {
  key: string
  match: SourceMatch
  catalogId: string | null
  ra: number
  dec: number
  // One detection per frame at most, with the frame's index.
  detections: { frame: number; source: DetectedSource }[]
}

export interface Feature {
  id: string
  label: string
  unit: string
  // The smallest spread that counts: a nearly constant feature must not turn noise into distance.
  floor: number
}

// The features, in the order of each source's vector.
export const FEATURES: Feature[] = [
  { id: 'brightness', label: 'Brightness (log₁₀ peak)', unit: 'log MJy/sr', floor: 0.1 },
  { id: 'variability', label: 'Brightness scatter between frames', unit: 'dex', floor: 0.05 },
  { id: 'presence', label: 'Share of frames with a detection (sources with S/N ≥ 10)', unit: '', floor: 0.1 },
  // About a fifth of a 6.15″ pixel: the centroid scatter of a steady star.
  { id: 'wander', label: 'Position scatter between frames', unit: '″', floor: 1 },
  { id: 'gaia', label: 'Gaia DR3 counterpart', unit: '', floor: 0.5 },
  { id: 'allwise', label: 'AllWISE counterpart', unit: '', floor: 0.5 },
  { id: 'colourG', label: 'SPHEREx − Gaia G (infrared excess)', unit: 'mag', floor: 0.25 },
  { id: 'colourW1', label: 'SPHEREx − WISE W1', unit: 'mag', floor: 0.25 },
]

export interface MapPoint {
  group: SourceGroup
  // Raw feature values; null where the feature cannot be measured for this source.
  values: (number | null)[]
  u: number
  v: number
  // Distance from the field's typical source in the standardised feature space; higher is more unusual.
  isolation: number
}

export interface SourceMap {
  method: 'umap' | 'pca' | 'none'
  frames: number
  points: MapPoint[]
}

const sepArcsec = (ra1: number, dec1: number, ra2: number, dec2: number) => {
  const dRa = ((ra2 - ra1 + 540) % 360) - 180
  return Math.hypot(dRa * Math.cos((dec1 * Math.PI) / 180), dec2 - dec1) * 3600
}

/**
 * One group per source across frames: a catalogue match by its catalogue id; a detection without one
 * ("none", or "unknown" when a catalogue failed for that frame) joins the nearest group within
 * GROUP_PIXELS that has no detection in that frame – a catalogue group too, so one failed lookup does
 * not split every star. A mover that leaves the radius becomes several short-lived groups, which the
 * "presence" feature then marks.
 */
export function groupSources(frames: Pick<Frame, 'sources'>[], pixelScaleArcsec: number): SourceGroup[] {
  const groups: SourceGroup[] = []
  const byCatalog = new Map<string, SourceGroup>()
  const radius = GROUP_PIXELS * pixelScaleArcsec
  frames.forEach((frame, index) => {
    for (const source of frame.sources ?? []) {
      let group: SourceGroup | undefined
      if (source.catalog_id) group = byCatalog.get(source.catalog_id)
      else {
        let best = radius
        for (const g of groups) {
          if (g.detections.some((d) => d.frame === index)) continue
          const sep = sepArcsec(g.ra, g.dec, source.ra, source.dec)
          if (sep <= best) { best = sep; group = g }
        }
      }
      if (!group) {
        // The group's index keeps keys unique when two unmatched detections share a position.
        group = { key: source.catalog_id ?? `pos ${groups.length} ${source.ra.toFixed(5)} ${source.dec.toFixed(5)}`,
          match: source.match, catalogId: source.catalog_id ?? null, ra: source.ra, dec: source.dec, detections: [] }
        groups.push(group)
        if (source.catalog_id) byCatalog.set(source.catalog_id, group)
      }
      if (!group.detections.some((d) => d.frame === index)) group.detections.push({ frame: index, source })
    }
  })
  return groups
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const std = (values: number[]) => {
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
}

/** The raw feature vector of one source (see FEATURES); null where it cannot be measured. */
export function featuresOf(group: SourceGroup, frames: number): (number | null)[] {
  const peaks = group.detections.map((d) => d.source.peak_mjy_sr).filter((p) => p > 0)
  const logs = peaks.map(Math.log10)
  const brightness = logs.length ? median(logs) : null
  const variability = logs.length >= 2 ? std(logs) : null
  const ras = group.detections.map((d) => d.source.ra)
  const decs = group.detections.map((d) => d.source.dec)
  const wander = group.detections.length >= 2
    ? Math.sqrt(group.detections.reduce((s, d) => s + sepArcsec(median(ras), median(decs), d.source.ra, d.source.dec) ** 2, 0)
      / group.detections.length)
    : null
  const known = group.match !== 'unknown'
  const mag = group.detections.find((d) => d.source.catalog_mag != null)?.source
  // A SPHEREx "magnitude" from the peak; only differences between sources matter after scaling.
  const spherexMag = brightness === null ? null : -2.5 * brightness
  const colour = (band: 'G' | 'W1') => (mag?.catalog_band === band && spherexMag !== null ? spherexMag - mag.catalog_mag! : null)
  return [
    brightness,
    variability,
    Math.max(...group.detections.map((d) => d.source.snr)) >= PRESENCE_MIN_SNR ? group.detections.length / Math.max(frames, 1) : null,
    wander,
    known ? Number(group.match === 'gaia') : null,
    known ? Number(group.match === 'allwise') : null,
    colour('G'),
    colour('W1'),
  ]
}

/**
 * Robust z-scores per feature (median, scaled MAD, never below the feature's floor); a feature a source
 * lacks gets the median (0 after scaling), so it neither pulls the source away nor towards others.
 */
export function standardise(rows: (number | null)[][], floors: number[] = FEATURES.map((f) => f.floor)): number[][] {
  const columns = rows[0]?.length ?? 0
  const scaled = rows.map(() => new Array<number>(columns).fill(0))
  for (let j = 0; j < columns; j++) {
    const known = rows.map((r) => r[j]).filter((v): v is number => v !== null && Number.isFinite(v))
    if (known.length < 2) continue
    const centre = median(known)
    const spread = Math.max(1.4826 * median(known.map((v) => Math.abs(v - centre))), floors[j] ?? 0)
    if (!(spread > 0)) continue
    rows.forEach((r, i) => {
      const value = r[j]
      scaled[i][j] = value === null || !Number.isFinite(value) ? 0 : (value - centre) / spread
    })
  }
  return scaled
}

/**
 * Distance from the field's typical source: the length of the robust z-score vector (median 0).
 * Not a nearest-neighbour distance: a mover splits into several alike short-lived groups that would be
 * each other's neighbours and look ordinary.
 */
export const isolationScores = (vectors: number[][]): number[] => vectors.map((v) => Math.hypot(...v))

/** Deterministic random numbers (mulberry32), so a field always gives the same map. */
export function seeded(seed = SEED) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** The first two principal components (power iteration with deflation). */
export function pca2(vectors: number[][]): [number, number][] {
  const n = vectors.length
  const dims = vectors[0]?.length ?? 0
  const mean = new Array<number>(dims).fill(0)
  vectors.forEach((v) => v.forEach((x, j) => { mean[j] += x / n }))
  let data = vectors.map((v) => v.map((x, j) => x - mean[j]))
  const out: [number, number][] = vectors.map(() => [0, 0])
  const random = seeded()
  for (let c = 0; c < 2; c++) {
    let w = Array.from({ length: dims }, () => random() - 0.5)
    for (let iter = 0; iter < 100; iter++) {
      const next = new Array<number>(dims).fill(0)
      for (const row of data) {
        const dot = row.reduce((s, x, j) => s + x * w[j], 0)
        row.forEach((x, j) => { next[j] += dot * x })
      }
      const norm = Math.hypot(...next)
      if (!(norm > 0)) break
      w = next.map((x) => x / norm)
    }
    data.forEach((row, i) => { out[i][c] = row.reduce((s, x, j) => s + x * w[j], 0) })
    data = data.map((row, i) => row.map((x, j) => x - out[i][c] * w[j]))
  }
  return out
}

export function buildSourceMap(frames: Pick<Frame, 'sources'>[], pixelScaleArcsec: number): SourceMap {
  const groups = groupSources(frames, pixelScaleArcsec)
  if (groups.length < 3) return { method: 'none', frames: frames.length, points: [] }
  const values = groups.map((g) => featuresOf(g, frames.length))
  const vectors = standardise(values)
  const isolation = isolationScores(vectors)
  let coords: number[][]
  let method: SourceMap['method']
  if (groups.length >= MIN_UMAP_SOURCES) {
    const umap = new UMAP({ nComponents: 2, nNeighbors: Math.min(15, groups.length - 1), minDist: 0.1, random: seeded() })
    coords = umap.fit(vectors)
    method = 'umap'
  } else {
    coords = pca2(vectors)
    method = 'pca'
  }
  return {
    method,
    frames: frames.length,
    points: groups.map((group, i) => ({ group, values: values[i], u: coords[i][0], v: coords[i][1], isolation: isolation[i] })),
  }
}

/** The most isolated sources first: where to look first. */
export const checkFirst = (map: SourceMap, count = 5) => [...map.points].sort((a, b) => b.isolation - a.isolation).slice(0, count)
