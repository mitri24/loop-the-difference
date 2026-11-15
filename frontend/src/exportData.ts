// The export file: everything the app holds for the comparison on screen, for the user's own records or further
// analysis. Always offered, also before a comparison is loaded (then it holds the search). Sharing the marks with a
// colleague on this site goes through the link (toSearch in url.ts), which the file carries too.
import type { BlinkPair } from './blink'
import { MARK_LETTERS, type Mark, type Verdict } from './candidate'
import type { PairChanges } from './pairDifference'
import { DAYS_PER_YEAR, REGIMES, possibleTrack, type PossibleTrack } from './track'
import type {
  DistantTrack, Fingerprint, Followup, Frame, FrameManifest, ObservationSummary, ProperMotion, SmallBodyEpoch, Spectrum,
} from './types'
import type { TargetQuery } from './url'

export const EXPORT_FORMAT = 'loop-the-difference/export@1'

// One marked object of the candidate check (useCandidate: objects and allMarks).
export interface ExportObject {
  index: number
  name: string
  marks: Mark[]
  // Only the active object's verdict is known to the app; null for the others.
  verdict: Verdict | null
  verdictChosen: boolean | null
}

export interface ExportInput {
  // Opens this comparison with its marks and A/B on this site.
  link: string
  // The target as the search bar names it.
  target: string
  query: TargetQuery
  motion: ProperMotion | null
  summary: ObservationSummary | null
  jobId: string | null
  manifest: FrameManifest | null
  objects: ExportObject[]
  // The player's A and B as frame indices, and the worker's changes between them.
  pair: BlinkPair | null
  pairChanges: PairChanges | null
  smallBodies: SmallBodyEpoch[]
  distant: DistantTrack | null
  followup: Followup | null
  fingerprint: Fingerprint | null
  spectrum: Spectrum | null
  exported: Date
  // Resolves the image URLs, which the API gives relative to the site.
  base: string
}

const MJD_UNIX_EPOCH = 40587
const mjdToIso = (mjd: number) => new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000).toISOString()

function frameRecord(frame: Frame, base: string) {
  // Every field the API gave (provenance included), the image addresses absolute.
  return { ...frame, url: new URL(frame.url, base).href }
}

function markRecord(mark: Mark, letter: string, manifest: FrameManifest | null, base: string) {
  const frame = manifest?.frames.find((f) => f.obs_id === mark.obs_id)
  const source = mark.source
  return {
    letter,
    ra_deg: mark.ra,
    dec_deg: mark.dec,
    sigma_arcsec: mark.sigma_arcsec,
    position: source ? 'detection' : 'as clicked',
    mjd: mark.mjd,
    time_utc: mjdToIso(mark.mjd),
    detection: source ? {
      snr: source.snr,
      peak_mjy_sr: source.peak_mjy_sr,
      x_pix: source.x,
      y_pix: source.y,
      match: source.match,
      catalog_id: source.catalog_id,
      separation_arcsec: source.separation_arcsec,
      catalog_mag: source.catalog_mag,
      catalog_band: source.catalog_band,
    } : null,
    frame: frame ? {
      obs_id: frame.obs_id,
      detector: frame.detector,
      date_utc: frame.date,
      date_end_utc: frame.date_end,
      epoch: frame.epoch + 1,
      exposures: frame.n_combined,
      release: frame.release ?? null,
      wavelength_um: frame.wavelength_um,
      image_url: new URL(frame.url, base).href,
      source_url: frame.source_url,
    } : { obs_id: mark.obs_id },
  }
}

function trackRecord(track: PossibleTrack | null) {
  return track ? {
    regime: REGIMES[track.regime].word,
    rate_arcsec_per_hour: track.fit.rate / 24,
    rate_sigma_arcsec_per_hour: track.fit.sigmaRate / 24,
    rate_arcsec_per_year: track.fit.rate * DAYS_PER_YEAR,
    position_angle_deg: track.fit.pa,
    marks: track.fit.n,
    residual_rms_arcsec: track.fit.rmsArcsec,
    predictions: track.predictions.map((p) => ({ mjd: p.mjd, ra_deg: p.ra, dec_deg: p.dec, search_radius_arcsec: p.radius_arcsec })),
  } : null
}

export function buildExport(input: ExportInput) {
  const { link, target, query, motion, summary, jobId, manifest, objects, pair, pairChanges, smallBodies, distant, followup,
    fingerprint, spectrum, exported, base } = input
  const abs = (url: string) => new URL(url, base).href
  const changes = pairChanges?.result ?? null
  return {
    format: EXPORT_FORMAT,
    note: 'Candidate marks are unverified and need checking. They are not a discovery.',
    times: 'A mark\'s mjd and time_utc are the time its position applies to, the mean of a stack\'s exposures; its frame\'s date_utc and date_end_utc are the first and last exposure.',
    exported_utc: exported.toISOString(),
    link,
    target,
    query: { ra: query.ra, dec: query.dec, fov_deg: query.fov, band: query.band, mode: query.mode, name: query.name ?? null },
    proper_motion: motion,
    observations: summary,
    comparison: manifest ? {
      job_id: jobId,
      ...manifest,
      release: manifest.release ?? null,
      preview: manifest.preview ?? false,
      pipeline_version: manifest.pipeline_version ?? null,
      collections: manifest.collection.split(',').map((c) => c.trim()).filter(Boolean),
      frames: manifest.frames.map((frame) => frameRecord(frame, base)),
      differences: manifest.differences.map((d) => ({ ...d, url: abs(d.url) })),
    } : null,
    // The panel always keeps an empty slot for the next object: only marked objects are data.
    objects: objects.filter((object) => object.marks.length > 0).map((object) => ({
      index: object.index + 1,
      name: object.name || null,
      verdict: object.verdict,
      verdict_chosen: object.verdictChosen,
      marks: object.marks.map((mark, i) => markRecord(mark, MARK_LETTERS[i] ?? `${i + 1}`, manifest, base)),
      possible_track: trackRecord(manifest ? possibleTrack(object.marks, manifest, manifest.frames.map((f) => f.mjd)) : null),
    })),
    pair: manifest && pair && manifest.frames[pair.a] && manifest.frames[pair.b]
      ? { a: manifest.frames[pair.a].obs_id, b: manifest.frames[pair.b].obs_id } : null,
    pair_changes: changes ? { ...changes, significance_url: abs(changes.significance_url), difference_url: abs(changes.difference_url) } : null,
    known_small_bodies: smallBodies.length > 0 ? smallBodies : null,
    distant_track: distant,
    followup,
    fingerprint,
    spectrum,
  }
}

export type ExportDocument = ReturnType<typeof buildExport>

/** The status line after the export: what the file holds. */
export function exportSummary(doc: ExportDocument): string {
  if (!doc.comparison) {
    return doc.observations ? 'Exported the search and its observation history – no comparison loaded yet'
      : 'Exported the search only – no comparison loaded yet'
  }
  const frames = doc.comparison.frames.length
  const marked = doc.objects.length
  const parts = [`${frames} ${frames === 1 ? 'frame' : 'frames'}`]
  if (marked) parts.push(`${marked} ${marked === 1 ? 'object' : 'objects'}`)
  if (doc.pair_changes) parts.push('A/B changes')
  if (doc.known_small_bodies) parts.push('known small bodies')
  if (doc.followup) parts.push('follow-up')
  if (doc.spectrum) parts.push('spectrum')
  return `Exported ${parts.join(', ')}`
}

export function exportFileName(target: string, exported: Date): string {
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'target'
  return `loop-the-difference-${slug}-${exported.toISOString().slice(0, 10)}.json`
}

/** Builds the file and offers it as a download; returns the status line. */
export function downloadExport(input: ExportInput): string {
  const doc = buildExport(input)
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = exportFileName(input.target, input.exported)
  anchor.click()
  // Some browsers (Safari) still read the file after the click returned.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return exportSummary(doc)
}
