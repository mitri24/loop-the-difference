import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFingerprint, getFingerprintJob } from './api'
import { FingerprintView } from './components/FingerprintCheck'
import { bandText, fingerprintError, fingerprintPhase, fingerprintProgress, spectrumPoints, type FingerprintState } from './fingerprint'
import { measurement } from './followupFixtures'
import type { Check, Fingerprint, FingerprintJob, FingerprintPoint, FingerprintRequest, MethaneBand, SpectralWindow } from './types'

// The windows as backend/app/fingerprint.py WINDOWS sends them.
const WINDOWS: SpectralWindow[] = [
  { code: 'h_peak', name: 'H peak', lo_um: 1.54, hi_um: 1.6, kind: 'continuum' },
  { code: 'ch4_1.7', name: 'CH₄ 1.7 µm', lo_um: 1.63, hi_um: 1.75, kind: 'band' },
  { code: 'k_peak', name: 'K peak', lo_um: 2.06, hi_um: 2.16, kind: 'continuum' },
  { code: 'ch4_2.25', name: 'CH₄ 2.25 µm', lo_um: 2.2, hi_um: 2.29, kind: 'band' },
  { code: 'ch4_3.3', name: 'CH₄ 3.3 µm', lo_um: 3.2, hi_um: 3.5, kind: 'band' },
  { code: 'peak_4um', name: '4 µm peak', lo_um: 3.9, hi_um: 4.15, kind: 'continuum' },
]
const point = (obs_id: string, detector: number, change: Partial<FingerprintPoint> = {}): FingerprintPoint => ({
  ...measurement(obs_id), detector, planned_wavelength_um: null, window: null, psf_flux_ujy: 20, psf_flux_err_ujy: 2, psf_snr: 10, ...change,
})
const band = (change: Partial<MethaneBand>): MethaneBand => ({
  band: 'ch4_1.7', continuum: ['h_peak', 'k_peak'], status: 'measured', points: 4, continuum_points: [3, 5], flux_ujy: 5, continuum_ujy: 22,
  depth: 0.78, depth_err: 0.07, sigma: 8.94, ...change,
})
const check = (code: string, severity: Check['severity'], message: string): Check => ({ code, severity, message, detail: '', affects: [] })
const FINGERPRINT: Fingerprint = {
  collection: 'spherex_dr1', ra: 150, dec: 20, detector: 3, model: 'straight-line heliocentric motion + Earth parallax', distance_au: 307.6,
  complete: true, psf_photometry: true, visits_total: 6, visits_measured: 3, windows: WINDOWS,
  points: [
    point('v1', 4, { wavelength_um: 1.65, mjd: 61000.2, date: '2026-01-10T05:00:00Z' }),
    point('v2', 5, { wavelength_um: 4.0, mjd: 61001.1, flagged: true }),
    point('v3', 2, { wavelength_um: 1.1, mjd: 61190.4, date: '2026-07-19T10:00:00Z', psf_flux_ujy: null, psf_flux_err_ujy: null, psf_snr: null }),
    point('v4', 6, { wavelength_um: null, psf_flux_ujy: null, psf_flux_err_ujy: null, psf_snr: null, flux_ujy: null, flux_err_ujy: null,
      snr: null, skipped: 'archive did not deliver the cutout' }),
  ],
  methane: {
    verdict: 'absorption', sigma: 3.8, summary: 'CH₄ absorption 3.8σ – as in T/Y brown dwarfs or a cold giant planet; check with more visits',
    bands: [band({}), band({ band: 'ch4_2.25', status: 'not_enough_channels', points: 1, continuum_points: [5, 0], depth: null, depth_err: null, sigma: null })],
  },
  checks: [check('CUTOUT_MISSING', 'warning', 'Archive did not deliver a cutout'), check('FINGERPRINT_PLAN', 'info', 'Visits chosen by wavelength')],
}
const job = (status: FingerprintJob['status'], change: Partial<FingerprintJob> = {}): FingerprintJob => ({
  job_id: 'fp1', status, progress: 0, total: 0, fingerprint: null, error: null, ...change,
})
const REQUEST = { ra: '150', dec: '20', detector: 3, marked: [], distance_au: 307.6 } as unknown as FingerprintRequest
const view = (state: Partial<Omit<FingerprintState, 'start'>>) => renderToStaticMarkup(
  <FingerprintView state={{ phase: 'idle', job: null, fingerprint: null, error: null, ...state }} start={() => undefined} />,
)

describe('fingerprint run', () => {
  it('goes from the request to the worker to a spectrum, and says why there is none', () => {
    const run = (change: object) => ({ attempt: 1, request: REQUEST, job: null, error: null, ...change })
    expect(fingerprintPhase({ attempt: 0, request: null, job: null, error: null })).toBe('idle')
    expect(fingerprintPhase(run({}))).toBe('sending')
    expect(fingerprintPhase(run({ job: job('started') }))).toBe('running')
    expect(fingerprintPhase(run({ job: job('finished', { fingerprint: FINGERPRINT }) }))).toBe('done')
    expect(fingerprintError(run({ job: job('failed', { error: 'SPHEREx archive (IRSA) is not reachable' }) }))).toBe('SPHEREx archive (IRSA) is not reachable')
    expect(fingerprintError(run({ job: job('not_found') }))).toBe('The fingerprint job expired.')
    expect(fingerprintError(run({ job: job('started') }))).toBeNull()
  })

  it('shows progress as cutouts loaded of all planned', () => {
    expect(fingerprintProgress(null)).toBe('Fingerprint: starting…')
    expect(fingerprintProgress(job('queued'))).toBe('Fingerprint: waiting for a free worker…')
    expect(fingerprintProgress(job('started'))).toBe('Fingerprint: searching the archive for visits of every detector…')
    expect(fingerprintProgress(job('started', { progress: 7, total: 48 }))).toBe('Fingerprint: 7 of 48 cutouts…')
  })
})

describe('fingerprint result', () => {
  it('names each CH₄ band’s depth with its error and σ, or why it has none', () => {
    expect(bandText(band({}), WINDOWS)).toBe('CH₄ 1.7 µm: depth 0.78 ± 0.07 (8.9σ)')
    expect(bandText(FINGERPRINT.methane.bands[1], WINDOWS))
      .toBe('CH₄ 2.25 µm: not enough channels (1 in the band, 5 and 0 in the continuum windows)')
    expect(bandText(band({ band: 'ch4_3.3', status: 'continuum_too_faint', depth: null, depth_err: null, sigma: null }), WINDOWS))
      .toBe('CH₄ 3.3 µm: continuum too faint')
  })

  it('draws the visits with a wavelength and a PSF total, by epoch, and leaves the rest to the list', () => {
    const points = spectrumPoints(FINGERPRINT)
    expect(points.map((p) => [p.obs_id, p.detector, p.wavelength_um, p.flux_ujy, p.epoch, p.flagged])).toEqual([
      ['v1', 4, 1.65, 20, 0, false], ['v2', 5, 4.0, 20, 0, true],
    ])
    const aperture = spectrumPoints({ ...FINGERPRINT, psf_photometry: false })
    expect(aperture.map((p) => [p.obs_id, p.flux_ujy, p.epoch])).toEqual([['v1', 12, 0], ['v2', 12, 0], ['v3', 12, 1]])
  })

  it('offers the fingerprint with what it costs, then shows progress and errors with Retry', () => {
    const idle = view({})
    expect(idle).toContain('<button type="button">Spectral fingerprint</button>')
    expect(idle).toContain('all six detectors (0.75–5 µm) and tests for methane bands. Loads up to 48 IRSA cutouts; takes minutes.')
    expect(view({ phase: 'running', job: job('started', { progress: 3, total: 40 }) })).toContain('role="status">Fingerprint: 3 of 40 cutouts…</p>')
    expect(view({ phase: 'error', error: 'The data service timed out.' }))
      .toContain('Fingerprint unavailable: The data service timed out. <button type="button">Retry</button>')
  })

  it('leads with the CH₄ line and folds the spectrum, the bands, every visit with its cutout and the checks', () => {
    const html = view({ phase: 'done', fingerprint: FINGERPRINT })
    const line = 'Fingerprint, 3 visits in D1–D6: CH₄ absorption 3.8σ – as in T/Y brown dwarfs or a cold giant planet; check with more visits'
    expect(html).toContain(`<p class="track-check-summary">${line}</p>`)
    expect(html.indexOf(line)).toBeLessThan(html.indexOf('<details'))
    expect(html).toContain('<summary>Spectrum, CH₄ bands, visits and checks</summary>')
    expect(html).toContain('Flux along the track by wavelength')
    expect(html).toContain('class="viz-window band"')
    expect(html).toContain('CH₄ 1.7 µm: depth 0.78 ± 0.07 (8.9σ)')
    expect(html).toContain('D4 · 2026-01-10 05:00 UTC · 1.650 µm · PSF 20.0 ± 2.0 µJy · S/N 10.0</span>')
    expect(html).toContain('D6 · 2026-05-28 10:00 UTC · archive did not deliver the cutout</span>')
    expect(html).toContain('href="https://irsa.example/v1.fits?center=150,20&amp;size=0.03" target="_blank" rel="noopener noreferrer">v1')
    expect(html).toContain('<span class="sr-only">Caution: </span>Archive did not deliver a cutout')
    expect(html).not.toContain('Incomplete')
    expect(html).not.toMatch(/confirmed|discover/i)
    expect(view({ phase: 'done', fingerprint: { ...FINGERPRINT, complete: false } }))
      .toContain('Incomplete: the archive did not answer every request. <button type="button">Retry</button>')
  })
})

describe('fingerprint API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('createFingerprint posts the request and getFingerprintJob polls by id, both with the caller’s abort signal', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(job('queued')), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(await createFingerprint(REQUEST, controller.signal)).toEqual(job('queued'))
    expect(await getFingerprintJob('fp1', controller.signal)).toEqual(job('queued'))
    const [[postUrl, post], [getUrl, get]] = fetch.mock.calls as unknown as [string, RequestInit][]
    expect([postUrl, post.method, JSON.parse(post.body as string)]).toEqual(['/api/followup/fingerprint', 'POST', REQUEST])
    expect(getUrl).toBe('/api/followup/fingerprint/fp1')
    controller.abort()
    expect([post.signal?.aborted, get.signal?.aborted]).toEqual([true, true])
  })
})
