import { describe, expect, it } from 'vitest'
import type { Mark } from './candidate'
import { MARKS_FORMAT, marksDocument, marksFileName } from './markExport'
import { possibleTrack } from './track'
import type { Frame, FrameManifest } from './types'

const frame = (obs_id: string, mjd: number, date: string): Frame => ({
  index: 0, url: `/api/frames/job/${obs_id}.png`, obs_id, date, mjd, detector: 3, wavelength_min_um: 1.6,
  wavelength_max_um: 1.7, coverage: 1, source_url: `https://irsa.ipac.caltech.edu/${obs_id}`, epoch: 0, n_combined: 1,
  date_end: null, masked_fraction: 0.01, wavelength_um: 1.65, bandwidth_um: 0.05, release: 'DR1',
})
const manifest = {
  collection: 'spherex_dr1, spherex_qr3', release: 'DR1', ra: 308.5283, dec: -22.8925, size_deg: 0.2, detector: 3,
  pixel_scale_arcsec: 6.15, epochs: 1, complete: true, stacked: false, warnings: [], checks: [], differences: [],
  frames: [frame('a', 61155.913413, '2026-04-25T21:55:00Z'), frame('b', 61157.882123, '2026-04-27T21:10:00Z')],
} as FrameManifest
const marks: Mark[] = [
  { obs_id: 'a', mjd: 61155.913413, date: '2026-04-25T21:55:00Z', ra: 308.523308, dec: -22.890191, sigma_arcsec: 1,
    source: { ra: 308.523308, dec: -22.890191, x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none', catalog_id: null,
      separation_arcsec: null, catalog_mag: null, catalog_band: null } },
  { obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.533543, dec: -22.894745, sigma_arcsec: 3 },
]
const exported = new Date('2026-11-15T10:30:00Z')

describe('marks file', () => {
  const doc = marksDocument({ link: 'https://example.org/?ra=1&dec=2&mark=a%3A1%2C2', target: 'Pluto', manifest, marks,
    track: possibleTrack(marks, manifest, [61156.323055]), verdict: 'needs follow-up', verdictChosen: false, exported, base: 'https://example.org/app/' })

  it('names its format, the caveat, the link back and the verdict', () => {
    expect(doc).toMatchObject({ format: MARKS_FORMAT, link: 'https://example.org/?ra=1&dec=2&mark=a%3A1%2C2', target: 'Pluto',
      verdict: 'needs follow-up', verdict_chosen: false, exported_utc: '2026-11-15T10:30:00.000Z' })
    expect(doc.note).toMatch(/unverified.*not a discovery/i)
    expect(doc.comparison).toMatchObject({ detector: 3, size_deg: 0.2, collections: ['spherex_dr1', 'spherex_qr3'] })
  })

  it('keeps each mark with its detection and the provenance of its frame', () => {
    expect(doc.marks[0]).toMatchObject({ letter: 'A', position: 'detection', sigma_arcsec: 1, detection: { snr: 122, x_pix: 40 },
      frame: { obs_id: 'a', detector: 3, date_utc: '2026-04-25T21:55:00Z', image_url: 'https://example.org/api/frames/job/a.png',
        source_url: 'https://irsa.ipac.caltech.edu/a', release: 'DR1', epoch: 1 } })
    expect(doc.marks[1]).toMatchObject({ letter: 'B', position: 'as clicked', detection: null, frame: { obs_id: 'b' } })
  })

  it('gives each mark the time its position applies to, from its MJD (a stack: the mean of its exposures)', () => {
    expect(doc.marks[0]).toMatchObject({ mjd: 61155.913413, time_utc: '2026-04-25T21:55:18.883Z' })
    expect(doc.marks[0]).not.toHaveProperty('date_utc')
    expect(doc.times).toMatch(/mean of a stack's exposures/)
  })

  it('carries the possible track in the units the panel shows', () => {
    expect(doc.possible_track?.rate_arcsec_per_hour).toBeCloseTo(0.798, 3)
    expect(doc.possible_track?.position_angle_deg).toBeCloseTo(116, 0)
    expect(doc.possible_track?.predictions).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  it('gets a file name from the target and the date', () => {
    expect(marksFileName('Pluto', exported)).toBe('candidate-marks-pluto-2026-11-15.json')
    expect(marksFileName('02:31:49.09, +89:15:50.8', exported)).toBe('candidate-marks-02-31-49-09-89-15-50-8-2026-11-15.json')
    expect(marksFileName('···', exported)).toBe('candidate-marks-target-2026-11-15.json')
  })
})
