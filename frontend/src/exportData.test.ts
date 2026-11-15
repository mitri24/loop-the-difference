import { describe, expect, it } from 'vitest'
import type { Mark } from './candidate'
import { EXPORT_FORMAT, buildExport, exportFileName, exportSummary, type ExportInput } from './exportData'
import type { Frame, FrameManifest, ObservationSummary } from './types'

const frame = (obs_id: string, mjd: number, date: string): Frame => ({
  index: 0, url: `/api/frames/job/${obs_id}.png`, obs_id, date, mjd, detector: 3, wavelength_min_um: 1.6,
  wavelength_max_um: 1.7, coverage: 1, source_url: `https://irsa.ipac.caltech.edu/${obs_id}`, epoch: 0, n_combined: 1,
  date_end: null, masked_fraction: 0.01, wavelength_um: 1.65, bandwidth_um: 0.05, release: 'DR1', exposure_s: 107.3,
})
const manifest = {
  collection: 'spherex_dr1, spherex_qr3', release: 'DR1', ra: 308.5283, dec: -22.8925, size_deg: 0.2, detector: 3,
  pixel_scale_arcsec: 6.15, epochs: 1, complete: true, stacked: false, pipeline_version: 13, warnings: [], checks: [],
  differences: [{ a: 0, b: 1, url: '/api/frames/job/diff.png', comparable: true, delta_lambda_pct: 0.3, obs_ids_a: ['a'], obs_ids_b: ['b'] }],
  frames: [frame('a', 61155.913413, '2026-04-25T21:55:00Z'), frame('b', 61157.882123, '2026-04-27T21:10:00Z')],
} as FrameManifest
const summary: ObservationSummary = { collection: 'spherex_dr1', ra: 308.5283, dec: -22.8925, count: 2, detectors: { '3': 2 },
  epochs: [{ start: '2026-04-25T21:55:00Z', end: '2026-04-27T21:10:00Z', count: 2 }],
  observations: [{ obs_id: 'a', detector: 3, wavelength_min_um: 1.6, wavelength_max_um: 1.7, mjd: 61155.913413,
    date: '2026-04-25T21:55:00Z', access_url: 'https://irsa.ipac.caltech.edu/a.fits', publisher_did: 'ivo://irsa.ipac/spherex_dr1?a' }] }
const marks: Mark[] = [
  { obs_id: 'a', mjd: 61155.913413, date: '2026-04-25T21:55:00Z', ra: 308.523308, dec: -22.890191, sigma_arcsec: 1,
    source: { ra: 308.523308, dec: -22.890191, x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none', catalog_id: null,
      separation_arcsec: null, catalog_mag: null, catalog_band: null } },
  { obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.533543, dec: -22.894745, sigma_arcsec: 3 },
]
const second: Mark[] = [{ obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.54, dec: -22.9, sigma_arcsec: 3 }]
const exported = new Date('2026-11-15T10:30:00Z')
const query = { ra: '308.5283', dec: '-22.8925', fov: 0.2, band: 3, mode: 'exposures' as const, name: 'Pluto' }
const empty: ExportInput = {
  link: 'https://example.org/?ra=1&dec=2', target: 'Pluto', query, motion: null, summary: null, jobId: null, manifest: null,
  objects: [], pair: null, pairChanges: null, smallBodies: [], distant: null, followup: null, fingerprint: null, spectrum: null,
  exported, base: 'https://example.org/app/',
}
const loaded: ExportInput = {
  ...empty, link: 'https://example.org/?ra=1&dec=2&mark=a%3A1%2C2', summary, jobId: 'job', manifest, pair: { a: 0, b: 1 },
  objects: [
    { index: 0, name: 'Moving candidate', marks, verdict: 'needs follow-up', verdictChosen: false },
    { index: 1, name: '', marks: second, verdict: null, verdictChosen: null },
  ],
  pairChanges: { pair: { a: 0, b: 1 }, status: 'done', error: null, result: { job_id: 'job', a: 0, b: 1, comparable: true, reason: null,
    method: 'zogy', significance_url: '/api/frames/job/sig.png', difference_url: '/api/frames/job/diff.png', delta_days: 2,
    delta_lambda_pct: 0.3, small_bodies_checked: false, residuals: [], checks: [] } },
}

describe('export file', () => {
  const doc = buildExport(loaded)

  it('names its format, the caveat, the link back, the search and the observation history', () => {
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, link: 'https://example.org/?ra=1&dec=2&mark=a%3A1%2C2', target: 'Pluto',
      exported_utc: '2026-11-15T10:30:00.000Z', query: { ra: '308.5283', band: 3, mode: 'exposures', name: 'Pluto', fov_deg: 0.2 } })
    expect(doc.note).toMatch(/unverified.*not a discovery/i)
    expect(doc.observations?.observations[0]).toMatchObject({ obs_id: 'a', publisher_did: 'ivo://irsa.ipac/spherex_dr1?a' })
  })

  it('keeps the whole manifest with its provenance and absolute image addresses', () => {
    expect(doc.comparison).toMatchObject({ job_id: 'job', detector: 3, size_deg: 0.2, pipeline_version: 13, preview: false,
      collections: ['spherex_dr1', 'spherex_qr3'] })
    expect(doc.comparison?.frames).toHaveLength(2)
    expect(doc.comparison?.frames[0]).toMatchObject({ obs_id: 'a', exposure_s: 107.3, url: 'https://example.org/api/frames/job/a.png',
      source_url: 'https://irsa.ipac.caltech.edu/a' })
    expect(doc.comparison?.differences[0].url).toBe('https://example.org/api/frames/job/diff.png')
  })

  it('lists every object with its marks, letters, detections, frames, verdict and track', () => {
    expect(doc.objects).toHaveLength(2)
    expect(doc.objects[0]).toMatchObject({ index: 1, name: 'Moving candidate', verdict: 'needs follow-up', verdict_chosen: false })
    expect(doc.objects[0].marks[0]).toMatchObject({ letter: 'A', position: 'detection', sigma_arcsec: 1, detection: { snr: 122, x_pix: 40 },
      mjd: 61155.913413, time_utc: '2026-04-25T21:55:18.883Z',
      frame: { obs_id: 'a', detector: 3, date_utc: '2026-04-25T21:55:00Z', image_url: 'https://example.org/api/frames/job/a.png', release: 'DR1', epoch: 1 } })
    expect(doc.objects[0].marks[1]).toMatchObject({ letter: 'B', position: 'as clicked', detection: null, frame: { obs_id: 'b' } })
    expect(doc.objects[0].possible_track?.rate_arcsec_per_hour).toBeCloseTo(0.798, 3)
    expect(doc.objects[0].possible_track?.position_angle_deg).toBeCloseTo(116, 0)
    // The second object: one mark, no verdict known, no track from one mark.
    expect(doc.objects[1]).toMatchObject({ index: 2, name: null, verdict: null, verdict_chosen: null, possible_track: null })
    expect(doc.objects[1].marks).toEqual([expect.objectContaining({ letter: 'A', frame: { ...doc.objects[0].marks[1].frame } })])
  })

  it('carries A and B as obs_ids, the pair changes with absolute images, and null for what is not loaded', () => {
    expect(doc.pair).toEqual({ a: 'a', b: 'b' })
    expect(doc.pair_changes).toMatchObject({ method: 'zogy', significance_url: 'https://example.org/api/frames/job/sig.png' })
    expect(doc).toMatchObject({ proper_motion: null, known_small_bodies: null, distant_track: null, followup: null, fingerprint: null, spectrum: null })
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  it('exports the search alone before a comparison is loaded', () => {
    const bare = buildExport(empty)
    expect(bare).toMatchObject({ format: EXPORT_FORMAT, comparison: null, observations: null, objects: [], pair: null })
    expect(exportSummary(bare)).toBe('Exported the search only – no comparison loaded yet')
    expect(exportSummary(buildExport({ ...empty, summary }))).toBe('Exported the search and its observation history – no comparison loaded yet')
  })

  it('says what was exported', () => {
    expect(exportSummary(doc)).toBe('Exported 2 frames, 2 objects, A/B changes')
    // The panel's empty slot for the next object is not data.
    const unmarked = buildExport({ ...loaded, objects: [{ index: 0, name: '', marks: [], verdict: 'needs follow-up', verdictChosen: false }], pairChanges: null })
    expect(unmarked.objects).toEqual([])
    expect(exportSummary(unmarked)).toBe('Exported 2 frames')
  })

  it('gets a file name from the target and the date', () => {
    expect(exportFileName('Pluto', exported)).toBe('loop-the-difference-pluto-2026-11-15.json')
    expect(exportFileName('02:31:49.09, +89:15:50.8', exported)).toBe('loop-the-difference-02-31-49-09-89-15-50-8-2026-11-15.json')
    expect(exportFileName('···', exported)).toBe('loop-the-difference-target-2026-11-15.json')
  })
})
