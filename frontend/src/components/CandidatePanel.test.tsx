import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../candidate'
import { possibleTrack, type PossibleTrack } from '../track'
import { CandidatePanel, stepStatuses } from './CandidatePanel'

const mark = (obs_id: string, date: string): Mark =>
  ({ obs_id, mjd: 61000, date, ra: 308.52331, dec: -22.89019, sigma_arcsec: 3 })
const render = (marks: Mark[], blocked: string | null = null, armed = false, track: PossibleTrack | null = null) => renderToStaticMarkup(
  <CandidatePanel candidate={{ marks, notice: '', armed, setArmed: () => undefined, clear: () => undefined }} blocked={blocked} track={track}
    known={{ epochs: [], motion: null, detector: 3, target: 'Pluto' }} lookBack={track && { checks: [], onShow: () => undefined }}
    visits={track && { observations: [], inBlink: [] }} />,
)
const expanded = (html: string) => [...html.matchAll(/aria-expanded="(true|false)" aria-controls="[^"]+"><span class="check-step-title">(\d)/g)]
  .filter((m) => m[1] === 'true').map((m) => Number(m[2]))

describe('CandidatePanel', () => {
  it('names the next action before any mark', () => {
    const html = render([])
    expect(html).toContain('Candidate check')
    expect(html).toContain('Spotted motion? Mark the object in two frames')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('Clear marks')
    expect(expanded(html)).toEqual([1])
    for (const title of ['1 Mark A and B', '2 Possible track', '3 Look back in SPHEREx', '4 Older observations', '5 Already known?', '6 Your verdict']) {
      expect(html).toContain(title)
    }
  })

  it('asks for a second frame after one mark and shows the state chip', () => {
    const html = render([mark('a', '2026-04-25T21:55:00Z')], null, true)
    expect(html).toContain('Now mark it in another frame')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('A · 2026-04-25 21:55 UTC')
    expect(html).toContain('Unverified candidate – needs verification')
  })

  it('lists A and B and disables the toggle with its reason', () => {
    const html = render([mark('a', '2026-04-25T21:55:00Z'), mark('b', '2026-10-25T21:55:00Z')], 'Not on the sky.')
    expect(html).not.toContain('Now mark it')
    expect(html).toContain('B · 2026-10-25 21:55 UTC')
    expect(html).toMatch(/<button type="button" aria-pressed="false" disabled="">/)
    expect(html).toContain('Not on the sky.')
    expect(html).toContain('Clear marks')
  })

  it('shows the possible track of Pluto frames 7 and 10 as possible motion', () => {
    const marks: Mark[] = [
      { obs_id: 'a', mjd: 61155.913413, date: '2026-04-25T21:55:00Z', ra: 308.523308, dec: -22.890191, sigma_arcsec: 1 },
      { obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.533543, dec: -22.894745, sigma_arcsec: 1 },
    ]
    const html = render(marks, null, false, possibleTrack(marks, { ra: 308.5283, dec: -22.8925 }, [61156.323055]))
    expect(html).toContain('Possible motion – needs verification')
    expect(html).toContain('Faster than any star')
    expect(html).toMatch(/0\.798 ± 0\.03″\/h/)
    expect(html).toContain('PA 116°')
    expect(html).toContain('2σ, from mark precision only')
    expect(html).not.toMatch(/orbit|trajectory found|confirmed|discovery/i)
    // Steps 1–4 are done and collapse to one line each; the next action, Already known?, is open.
    expect(expanded(html)).toEqual([5])
    expect(html).toContain('A 2026-04-25 21:55 · B 2026-04-27 21:10 UTC')
    expect(html).toContain('Track: 0.798″/h ± 0.03, PA 116°')
    expect(html).toContain('Consistent with the possible track in 0 of 0 other frames')
    expect(html).toContain('Clear marks')
  })

  it('step states: not started, in progress, done, not possible with the reason', () => {
    const track = (regime: PossibleTrack['regime']) => ({ regime }) as PossibleTrack
    const kinds = (...args: Parameters<typeof stepStatuses>) => stepStatuses(...args).map((s) => 'reason' in s ? s.reason : s.kind)
    expect(kinds(0, null, false, false)).toEqual(['todo', 'todo', 'todo', 'todo'])
    expect(kinds(1, null, false, true)).toEqual(['active', 'todo', 'todo', 'todo'])
    expect(kinds(2, null, false, true)).toEqual(['done', 'these marks give no fit', 'needs a possible track', 'needs a possible track'])
    expect(kinds(2, track('stellar'), true, false)).toEqual(['done', 'done', 'done', 'active'])
    expect(kinds(2, track('none'), false, true)).toEqual(['done', 'done', 'no significant motion', 'done'])
    expect(kinds(2, track('solarSystem'), false, true)[2]).toBe('no straight-line prediction across epochs')
    expect(kinds(2, track('fast'), false, true)[2]).toBe('switch from Difference to single frames')
  })
})
