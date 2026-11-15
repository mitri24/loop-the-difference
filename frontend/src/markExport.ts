// The marks file: everything the candidate check knows, for the user's own records or a colleague. The link in it
// opens the same comparison with the same marks on this site again.
import { MARK_LETTERS, type Mark, type Verdict } from './candidate'
import { DAYS_PER_YEAR, REGIMES, type PossibleTrack } from './track'
import type { FrameManifest } from './types'

export const MARKS_FORMAT = 'loop-the-difference/candidate-marks@1'

export interface MarksInput {
  // Opens this comparison with these marks (see toSearch in url.ts).
  link: string
  // The target as the search bar names it.
  target: string
  manifest: FrameManifest
  marks: Mark[]
  track: PossibleTrack | null
  verdict: Verdict
  exported: Date
  // Resolves the image URLs, which the API gives relative to the site.
  base: string
}

export function marksDocument({ link, target, manifest, marks, track, verdict, exported, base }: MarksInput) {
  return {
    format: MARKS_FORMAT,
    note: 'Candidate marks are unverified and need checking. They are not a discovery.',
    link,
    exported_utc: exported.toISOString(),
    target,
    comparison: {
      ra_deg: manifest.ra,
      dec_deg: manifest.dec,
      size_deg: manifest.size_deg,
      detector: manifest.detector,
      pixel_scale_arcsec: manifest.pixel_scale_arcsec,
      stacked: manifest.stacked,
      release: manifest.release ?? null,
      collections: manifest.collection.split(',').map((c) => c.trim()).filter(Boolean),
    },
    verdict,
    marks: marks.map((mark, i) => {
      const frame = manifest.frames.find((f) => f.obs_id === mark.obs_id)
      const source = mark.source
      return {
        letter: MARK_LETTERS[i],
        ra_deg: mark.ra,
        dec_deg: mark.dec,
        sigma_arcsec: mark.sigma_arcsec,
        position: source ? 'detection' : 'as clicked',
        date_utc: mark.date,
        mjd: mark.mjd,
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
          wavelength_min_um: frame.wavelength_min_um,
          wavelength_max_um: frame.wavelength_max_um,
          coverage: frame.coverage,
          masked_fraction: frame.masked_fraction,
          image_url: new URL(frame.url, base).href,
          source_url: frame.source_url,
        } : { obs_id: mark.obs_id },
      }
    }),
    possible_track: track ? {
      regime: REGIMES[track.regime].word,
      rate_arcsec_per_hour: track.fit.rate / 24,
      rate_sigma_arcsec_per_hour: track.fit.sigmaRate / 24,
      rate_arcsec_per_year: track.fit.rate * DAYS_PER_YEAR,
      position_angle_deg: track.fit.pa,
      marks: track.fit.n,
      residual_rms_arcsec: track.fit.rmsArcsec,
      predictions: track.predictions.map((p) => ({ mjd: p.mjd, ra_deg: p.ra, dec_deg: p.dec, search_radius_arcsec: p.radius_arcsec })),
    } : null,
  }
}

export function marksFileName(target: string, exported: Date): string {
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'target'
  return `candidate-marks-${slug}-${exported.toISOString().slice(0, 10)}.json`
}

export function downloadMarks(input: MarksInput): void {
  const blob = new Blob([`${JSON.stringify(marksDocument(input), null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = marksFileName(input.target, input.exported)
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
