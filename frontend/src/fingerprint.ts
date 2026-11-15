// Spectral fingerprint of a follow-up's track (POST /api/followup/fingerprint, backend/app/fingerprint.py): the flux
// where the track puts the object in the visits of all six detectors, joined to a spectrum with a CH₄ index. Started
// on request only, since every visit is an IRSA cutout. Methane is a reason to look closer, never an identification.
import { useEffect, useState } from 'react'
import { createFingerprint, getFingerprintJob } from './api'
import { errorText } from './distantTrack'
import type { FollowupPhase } from './followup'
import { groupEpochs } from './timeAxis'
import type { Fingerprint, FingerprintJob, FingerprintRequest, MethaneBand, SpectralWindow, SpectrumPoint } from './types'

const POLL_MS = 3000

interface FingerprintRun {
  attempt: number
  request: FingerprintRequest | null
  job: FingerprintJob | null
  error: string | null
}

const NO_RUN: FingerprintRun = { attempt: 0, request: null, job: null, error: null }

export function fingerprintPhase(run: FingerprintRun): FollowupPhase {
  if (!run.request) return 'idle'
  if (run.error) return 'error'
  if (!run.job) return 'sending'
  if (run.job.status === 'queued' || run.job.status === 'started') return 'running'
  return run.job.status === 'finished' && run.job.fingerprint ? 'done' : 'error'
}

/** Why the run has no result: the request failed, the job failed, or the job is gone. */
export function fingerprintError(run: FingerprintRun): string | null {
  if (fingerprintPhase(run) !== 'error') return null
  if (run.error) return run.error
  if (run.job?.status === 'failed') return run.job.error ?? 'The fingerprint job failed.'
  return 'The fingerprint job expired.'
}

export interface FingerprintState {
  phase: FollowupPhase
  job: FingerprintJob | null
  fingerprint: Fingerprint | null
  error: string | null
  // Starts the job, or again after an error or an incomplete result; nothing without a request.
  start: (request: FingerprintRequest | null) => void
}

/** One fingerprint job: an answer for an earlier attempt is dropped, unmounting aborts the request or the polling. */
export function useFingerprint(): FingerprintState {
  const [run, setRun] = useState(NO_RUN)
  const phase = fingerprintPhase(run)
  const { attempt, request, job } = run

  useEffect(() => {
    if (phase !== 'sending' || !request) return
    const controller = new AbortController()
    createFingerprint(request, controller.signal).then(
      (next) => setRun((old) => (old.attempt === attempt ? { ...old, job: next } : old)),
      (cause: unknown) => {
        if (!controller.signal.aborted) setRun((old) => (old.attempt === attempt ? { ...old, error: errorText(cause) } : old))
      },
    )
    return () => controller.abort()
  }, [phase, request, attempt])

  useEffect(() => {
    if (phase !== 'running' || !job) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getFingerprintJob(job.job_id, controller.signal).then(
        (next) => setRun((old) => (old.attempt === attempt ? { ...old, job: next } : old)),
        (cause: unknown) => {
          if (!controller.signal.aborted) setRun((old) => (old.attempt === attempt ? { ...old, error: errorText(cause) } : old))
        },
      )
    }, POLL_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [phase, job, attempt])

  return {
    phase,
    job,
    fingerprint: phase === 'done' ? job?.fingerprint ?? null : null,
    error: fingerprintError(run),
    start: (next) => {
      if (next) setRun((old) => ({ attempt: old.attempt + 1, request: next, job: null, error: null }))
    },
  }
}

/** While the job runs: waiting, searching the archive, then the cutouts loaded so far. */
export function fingerprintProgress(job: FingerprintJob | null): string {
  if (!job) return 'Fingerprint: starting…'
  if (job.status === 'queued') return 'Fingerprint: waiting for a free worker…'
  if (job.total === 0) return 'Fingerprint: searching the archive for visits of every detector…'
  return `Fingerprint: ${job.progress} of ${job.total} cutouts…`
}

/** One CH₄ band: its depth below the continuum with error and σ, or why it has none. */
export function bandText(band: MethaneBand, windows: SpectralWindow[]): string {
  const name = windows.find((w) => w.code === band.band)?.name ?? band.band
  if (band.status === 'measured' && band.depth != null && band.depth_err != null) {
    const sigma = band.sigma != null ? ` (${band.sigma.toFixed(1)}σ)` : ''
    return `${name}: depth ${band.depth.toFixed(2)} ± ${band.depth_err.toFixed(2)}${sigma}`
  }
  if (band.status === 'continuum_too_faint') return `${name}: continuum too faint`
  return `${name}: not enough channels (${band.points} in the band, ${band.continuum_points.join(' and ')} in the continuum windows)`
}

/**
 * The visits with a wavelength and a flux as spectrum points: PSF totals when the fingerprint has them, else the
 * aperture flux; marker shape = epoch, grouped as the backend groups epochs.
 */
export function spectrumPoints(fingerprint: Fingerprint): SpectrumPoint[] {
  const epochs = groupEpochs(fingerprint.points.map((p) => p.mjd))
  return fingerprint.points.flatMap((p) => {
    const [flux, err] = fingerprint.psf_photometry ? [p.psf_flux_ujy, p.psf_flux_err_ujy] : [p.flux_ujy, p.flux_err_ujy]
    if (p.wavelength_um == null || flux == null || err == null) return []
    return [{
      obs_id: p.obs_id, date: p.date, mjd: p.mjd, detector: p.detector, epoch: epochs.findIndex((e) => p.mjd >= e.start && p.mjd <= e.end),
      wavelength_um: p.wavelength_um, bandwidth_um: p.bandwidth_um ?? 0, flux_ujy: flux, flux_err_ujy: err, flagged: p.flagged,
      source_url: p.source_url,
    }]
  })
}
