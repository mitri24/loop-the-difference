import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../candidate'
import { CandidatePanel } from './CandidatePanel'

const mark = (obs_id: string, date: string): Mark =>
  ({ obs_id, mjd: 61000, date, ra: 308.52331, dec: -22.89019, sigma_arcsec: 3 })
const render = (marks: Mark[], blocked: string | null = null, armed = false) => renderToStaticMarkup(
  <CandidatePanel candidate={{ marks, notice: '', armed, setArmed: () => undefined, clear: () => undefined }} blocked={blocked} />,
)

describe('CandidatePanel', () => {
  it('names the next action before any mark', () => {
    const html = render([])
    expect(html).toContain('Candidate check')
    expect(html).toContain('Spotted motion? Mark the object in two frames')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('Clear marks')
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
})
