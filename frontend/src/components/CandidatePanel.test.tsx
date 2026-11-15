import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../candidate'
import type { DistantTrackState } from '../distantTrack'
import type { FollowupState } from '../followup'
import { possibleTrack, type PossibleTrack } from '../track'
import { CandidatePanel } from './CandidatePanel'

const mark = (obs_id: string, date: string): Mark =>
  ({ obs_id, mjd: 61000, date, ra: 308.52331, dec: -22.89019, sigma_arcsec: 3 })
const render = (
  marks: Mark[], blocked: string | null = null, armed = false, track: PossibleTrack | null = null, distant?: DistantTrackState, sources = true,
  followup?: FollowupState,
) => renderToStaticMarkup(
  <CandidatePanel candidate={{ marks, notice: '', armed, setArmed: () => undefined, clear: () => undefined }} blocked={blocked} track={track}
    known={{ epochs: [], motion: null, detector: 3, target: 'Pluto' }} distant={distant} sources={sources} followup={followup} />,
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
    expect(html).toContain('Click the object in the image. &quot;Mark&quot; in Detected sources works too.')
    expect(html).toContain('A · 2026-04-25 21:55 UTC')
    expect(html).toContain('Unverified candidate – needs verification')
  })

  it('names only what is on screen: without the sky view no detected sources are listed', () => {
    expect(render([], null, true, null, undefined, false)).toContain('<p class="candidate-hint">Click the object in the image.</p>')
    expect(render([], null, false, null, undefined, false)).not.toContain('detected source')
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
    expect(html).not.toMatch(/orbit|trajectory found|confirmed/i)
    expect(html).not.toContain('Distant-object track')
  })

  it('adds the distant-object track result under the possible track', () => {
    const marks: Mark[] = [
      { obs_id: 'a', mjd: 61155.913413, date: '2026-04-25T21:55:00Z', ra: 308.523308, dec: -22.890191, sigma_arcsec: 1 },
      { obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.533543, dec: -22.894745, sigma_arcsec: 1 },
    ]
    const distant: DistantTrackState = {
      status: 'ready', range: [20, 2000], error: null, track: null, rows: [], retry: () => undefined,
      summary: { kind: 'nothing', checked: 5, outside: 0 },
    }
    const html = render(marks, null, false, possibleTrack(marks, { ra: 308.5283, dec: -22.8925 }, [61172.96]), distant)
    expect(html).toContain('Faster than any star')
    expect(html).toContain('Distant-object track: no uncatalogued detection on the possible positions inside the field in 5 other images')
    expect(html.indexOf('Faster than any star')).toBeLessThan(html.indexOf('Distant-object track'))
  })

  it('offers to check all SPHEREx visits under the distant-object track, never by itself', () => {
    const marks: Mark[] = [
      { obs_id: 'a', mjd: 61155.913413, date: '2026-04-25T21:55:00Z', ra: 308.523308, dec: -22.890191, sigma_arcsec: 1 },
      { obs_id: 'b', mjd: 61157.882123, date: '2026-04-27T21:10:00Z', ra: 308.533543, dec: -22.894745, sigma_arcsec: 1 },
    ]
    const distant: DistantTrackState = {
      status: 'ready', range: [20, 2000], error: null, track: null, rows: [], retry: () => undefined,
      summary: { kind: 'nothing', checked: 5, outside: 0 },
    }
    const followup: FollowupState = {
      kind: 'distances', phase: 'idle', job: null, followup: null, error: null, ready: () => true, start: () => undefined,
    }
    const html = render(marks, null, false, possibleTrack(marks, { ra: 308.5283, dec: -22.8925 }, [61172.96]), distant, true, followup)
    expect(html.indexOf('Distant-object track')).toBeLessThan(html.indexOf('Check all SPHEREx visits'))
    expect(html.indexOf('Check all SPHEREx visits')).toBeLessThan(html.indexOf('Check known objects'))
    expect(render(marks, null, false, null, distant, true, { ...followup, kind: null })).not.toContain('Check all SPHEREx visits')
  })
})
