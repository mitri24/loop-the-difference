// Test data for the follow-up (followup.test.tsx, FollowupCheck.test.tsx): one visit, one hypothesis, one result.
import type { Followup, FollowupHypothesis, FollowupMeasurement } from './types'

export const measurement = (obs_id: string, change: Partial<FollowupMeasurement> = {}): FollowupMeasurement => ({
  obs_id, date: '2026-05-28T10:00:00Z', mjd: 61188.4, ra: 150, dec: 20, radius_arcsec: 2, model_error_arcsec: 0.5, position_uncertain: false,
  flux_ujy: 12, flux_err_ujy: 2, snr: 6, psf_flux_ujy: null, psf_flux_err_ujy: null, psf_snr: null, flagged: false, skipped: null,
  wavelength_um: 1.2, bandwidth_um: 0.03, source_url: `https://irsa.example/${obs_id}.fits?center=150,20&size=0.03`, ...change,
})

export const hypothesis = (
  distance_au: number | null, snr: number | null, visits: number, measurements: FollowupMeasurement[] = [],
): FollowupHypothesis => ({
  distance_au, flux_ujy: snr == null ? null : 2 * snr, flux_err_ujy: snr == null ? null : 2, snr, visits, measurements,
})

export const followupOf = (change: Partial<Followup>): Followup => ({
  collection: 'spherex_dr1', ra: 150, dec: 20, detector: 3, model: 'straight-line heliocentric motion + Earth parallax', complete: true,
  best: null, significant: false, distance_determined: false, psf_photometry: false, hypotheses: [], checks: [],
  global_sigma: null, independent_trials: 0, visits_total: 0, visits_measured: 0, not_covered_reasons: [], ...change,
})
