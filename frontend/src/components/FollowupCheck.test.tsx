import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FollowupState } from '../followup'
import type { Check, Followup, FollowupHypothesis, FollowupMeasurement } from '../types'
import { FollowupCheck, checkLines } from './FollowupCheck'
import { distanceTicks } from './FollowupChart'

const state = (change: Partial<FollowupState>): FollowupState => ({
  kind: 'distances', phase: 'idle', job: null, followup: null, error: null, ready: () => true, start: () => undefined, ...change,
})
const render = (change: Partial<FollowupState>) => renderToStaticMarkup(<FollowupCheck state={state(change)} observations={null} />)

const measurement = (obs_id: string, change: Partial<FollowupMeasurement> = {}): FollowupMeasurement => ({
  obs_id, date: '2026-05-28T10:00:00Z', mjd: 61188.4, ra: 150, dec: 20, radius_arcsec: 2, model_error_arcsec: 0.5, position_uncertain: false,
  flux_ujy: 12, flux_err_ujy: 2, snr: 6, flagged: false, skipped: null, wavelength_um: 1.2, bandwidth_um: 0.03,
  source_url: `https://irsa.example/${obs_id}.fits?center=150,20&size=0.03`, ...change,
})
const VISITS = [
  measurement('2026W22_1A_0001_1'),
  measurement('2026W22_1A_0002_1', { date: '2026-05-29T11:30:00Z', flagged: true, position_uncertain: true }),
  measurement('2026W22_1A_0003_1', { date: '2026-05-30T12:00:00Z', flux_ujy: null, flux_err_ujy: null, snr: null, wavelength_um: null,
    skipped: 'target at the cutout edge' }),
]
const hypothesis = (distance_au: number | null, snr: number, visits: number, measurements: FollowupMeasurement[] = []): FollowupHypothesis => ({
  distance_au, flux_ujy: 2 * snr, flux_err_ujy: 2, snr, visits, measurements,
})
const check = (code: string, severity: Check['severity'], message: string, detail = ''): Check => ({ code, severity, message, detail, affects: [] })
const CHECKS = [
  check('FOLLOWUP_QUICK_LOOK', 'info', 'Quick-look photometry, not calibrated', 'Aperture flux at each predicted position without aperture correction'),
  check('CUTOUT_MISSING', 'warning', 'Archive did not deliver a cutout', 'v1: archive sent no readable FITS'),
  check('CUTOUT_MISSING', 'warning', 'Archive did not deliver a cutout', 'v2: archive sent no readable FITS'),
  check('FOLLOWUP_SIGNIFICANCE', 'info', 'Flux along the track at 308 AU (S/N 7.2): a candidate to check, not a detection',
    'Inverse-variance weighted flux over 2 visits; the best of 12 independent hypotheses is inflated by chance: 7.2σ local ≈ 4.1σ global'),
]
const FOUND: Followup = {
  collection: 'spherex_dr1', ra: 150, dec: 20, detector: 3, model: 'straight-line heliocentric motion + Earth parallax', complete: true,
  best: 2, significant: true, distance_determined: true, checks: CHECKS,
  hypotheses: [hypothesis(20, 1.2, 2), hypothesis(40, 2.1, 1), hypothesis(307.6, 7.24, 2, VISITS), hypothesis(2000, -0.4, 2)],
}

describe('FollowupCheck', () => {
  it('offers nothing without a track to follow up, and only a button before it is asked', () => {
    expect(render({ kind: null })).toBe('')
    const idle = render({})
    expect(idle).toContain('<button type="button">Check all SPHEREx visits</button>')
    expect(idle).toContain('Loads IRSA cutouts; takes minutes.')
    const waiting = render({ kind: 'line', ready: () => false })
    expect(waiting).toContain('<button type="button" disabled="">Check all SPHEREx visits</button>')
    expect(waiting).toContain('Needs the archive’s list of this field’s visits.')
  })

  it('shows progress as cutouts loaded, and an error with Retry', () => {
    const running = render({ phase: 'running', job: { job_id: 'abc', status: 'started', progress: 12, total: 40, followup: null, error: null } })
    expect(running).toBe('<p class="candidate-hint" role="status">Follow-up: 12 of 40 cutouts…</p>')
    const failed = render({ phase: 'error', error: 'SPHEREx archive (IRSA) is not reachable' })
    expect(failed).toContain('role="alert">Follow-up unavailable: SPHEREx archive (IRSA) is not reachable')
    expect(failed).toContain('>Retry</button>')
  })

  it('leads with the result line and folds the S/N curve, the visits and the checks', () => {
    const html = render({ phase: 'done', followup: FOUND })
    const line = 'Follow-up: S/N 7.2 at 310 AU in 2 visits (4.1σ after 12 independent distances) – a candidate to check'
    expect(html).toContain(`<p class="track-check-summary">${line}</p>`)
    expect(html.indexOf(line)).toBeLessThan(html.indexOf('<details'))
    expect(html).toContain('<details class="disclosure"><summary>S/N per distance, visits and checks</summary>')
    expect(html).not.toContain('Check all SPHEREx visits')
    expect(html).not.toContain('Incomplete')
    // The chart in the app's chart frame, with its table.
    expect(html).toContain('<figure class="viz followup-chart"')
    expect(html).toContain('aria-label="S/N at 4 assumed distances from 20 to 2000 AU, highest 7.2 at 310 AU"')
    expect(html).toContain('>Table</button>')
    expect(html).toContain('<td>308 (best)</td><td>7.2</td><td>14.48 ± 2.00</td><td>2</td>')
    // Every visit of the best distance: date, λ, flux, S/N, what qualifies it and the cutout as provenance.
    expect(html).toContain('At 310 AU, D3: 2 of 3 visits usable')
    expect(html).toContain('2026-05-28 10:00 UTC · 1.200 µm · 12.0 ± 2.0 µJy · S/N 6.0</span>')
    expect(html).toContain('2026-05-29 11:30 UTC · 1.200 µm · 12.0 ± 2.0 µJy · S/N 6.0 · flagged pixels, left out · position uncertain')
    expect(html).toContain('2026-05-30 12:00 UTC · target at the cutout edge')
    expect(html).toContain('href="https://irsa.example/2026W22_1A_0001_1.fits?center=150,20&amp;size=0.03" target="_blank" rel="noopener noreferrer">2026W22_1A_0001_1')
    // The checks in short: the most severe first, a repeated one counted.
    expect(html).toContain('<span class="sr-only">Caution: </span>Archive did not deliver a cutout (2×)')
    expect(html.indexOf('Archive did not deliver')).toBeLessThan(html.indexOf('Quick-look photometry'))
    expect(html).toContain('Quick-look photometry, not calibrated<span class="candidate-hint"> – Aperture flux')
    expect(html).not.toMatch(/confirmed|discover/i)
  })

  it('says when the result is incomplete and offers to measure again', () => {
    const html = render({ phase: 'done', followup: { ...FOUND, complete: false } })
    expect(html).toContain('<p class="notice">Incomplete: the archive did not answer every request. <button type="button">Retry</button></p>')
  })

  it('names no distance and draws no curve for a straight line', () => {
    const line: Followup = { ...FOUND, model: 'straight line through the marks', best: 0, distance_determined: false, checks: [],
      hypotheses: [hypothesis(null, 6.31, 2, VISITS)] }
    const html = render({ kind: 'line', phase: 'done', followup: line })
    expect(html).toContain('Follow-up: S/N 6.3 along the straight line in 2 visits – a candidate to check')
    expect(html).toContain('<summary>Visits and checks</summary>')
    expect(html).toContain('Along the straight line, D3: 2 of 3 visits usable')
    expect(html).not.toContain('viz')
  })
})

describe('follow-up details', () => {
  it('groups a check repeated per visit and orders by severity', () => {
    expect(checkLines(CHECKS).map(({ code, severity, count }) => [code, severity, count])).toEqual([
      ['CUTOUT_MISSING', 'warning', 2], ['FOLLOWUP_QUICK_LOOK', 'info', 1], ['FOLLOWUP_SIGNIFICANCE', 'info', 1],
    ])
    expect(checkLines(CHECKS)[0].detail).toBe('')
  })

  it('labels both ends of the distance axis and round distances between that keep their distance', () => {
    // An axis spaced in 1/d over 300 px, as in the chart.
    const x = (near: number, far: number) => (au: number) => (300 * (1 / near - 1 / au)) / (1 / near - 1 / far)
    expect(distanceTicks(20, 2000, x(20, 2000))).toEqual([20, 30, 50, 100, 2000])
    expect(distanceTicks(20, 276.6, x(20, 276.6))).toEqual([20, 30, 50, 100, 276.6])
    expect(distanceTicks(100, 100, () => 0)).toEqual([100])
  })
})
