import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { summarizeDistant, type DistantRow, type DistantTrackState } from '../distantTrack'
import type { FrameCheck } from '../track'
import type { DetectedSource, DistantTrack, Frame } from '../types'
import { DistantTrackCheck, TrackCheck, distantSummaryText } from './TrackCheck'

const frame = (obs_id: string, date: string, coverage = 1) => ({ obs_id, date, coverage }) as Frame
const prediction = { mjd: 0, ra: 308.52543, dec: -22.89155, radius_arcsec: 1.6 }
const source = { snr: 177.2, match: 'none' } as DetectedSource
const checks: FrameCheck[] = [
  { index: 1, frame: frame('a', '2026-05-12T07:45:12Z'), prediction, radius_arcsec: 9.2, result: { kind: 'detection', source, sep_arcsec: 0.84 } },
  { index: 2, frame: frame('b', '2026-05-12T10:00:00Z', 0.8), prediction, radius_arcsec: 9.2, result: { kind: 'nothing' } },
  { index: 3, frame: frame('c', '2026-05-12T11:00:00Z'), prediction, radius_arcsec: 9.2, result: { kind: 'outside' } },
  { index: 4, frame: frame('d', '2026-05-12T12:00:00Z'), prediction, radius_arcsec: 9.2, result: { kind: 'noSources' } },
  { index: 5, frame: frame('e', '2026-05-28T00:00:00Z'), prediction: null, radius_arcsec: 9.2, result: { kind: 'window' } },
]

describe('TrackCheck', () => {
  it('lists every other frame within the straight-line window with one result, the summary and the caveat, never a verdict', () => {
    const html = renderToStaticMarkup(<TrackCheck checks={checks} onShow={() => undefined} />)
    expect(html).toContain('Consistent with the possible track in 1 of 2 other frames')
    expect(html).toContain('2026-05-12 07:45 UTC · RA 308.52543° Dec −22.89155° · r 9.2″ · ◎ detection 0.8″ from the prediction (S/N 177, × No catalogue match – needs verification)')
    expect(html).toContain('– nothing ≥5σ within 9.2″ (frame only partly covered)')
    expect(html).toContain('outside this frame')
    expect(html).toContain('no source list – reload this comparison')
    // Beyond the window the distant-object track takes over.
    expect(html).not.toContain('2026-05-28')
    expect(html).not.toContain('distance hypotheses')
    expect(html.match(/Show on the sky/g)).toHaveLength(4)
    expect(html).toContain('A detection near a prediction can be another source; nothing ≥5σ can mean too faint.')
    expect(html).not.toMatch(/confirmed|found/i)
  })
  it('shows nothing when every other frame lies beyond the window', () => {
    expect(renderToStaticMarkup(<TrackCheck checks={[checks[4]]} onShow={() => undefined} />)).toBe('')
  })
  it('says when a frame holds only the brightest detections', () => {
    const full = { ...checks[1], frame: { ...checks[1].frame, coverage: 1, sources: Array(300).fill(source) } }
    const html = renderToStaticMarkup(<TrackCheck checks={[full]} onShow={() => undefined} />)
    expect(html).toContain('– nothing ≥5σ within 9.2″ (source list holds only the 300 brightest)')
  })
})

const DISTANCES = [20, 25, 40, 100, 2000]
const ALL = [0, 1, 2, 3, 4]
const TRACK: DistantTrack = {
  model: 'straight-line heliocentric motion + Earth parallax',
  assumptions: ['Each hypothesis is one assumed distance from Earth at the first mark, not an orbit.'],
  hypotheses: DISTANCES.map((distance_au) => ({ distance_au, points: [] })),
}
const nearest = (sep_arcsec: number, snr: number, match: DetectedSource['match'] = 'none') => ({ source: { ...source, snr, match }, sep_arcsec })
const rows: DistantRow[] = [
  { frame: frame('old', '2025-03-01T10:00:00Z'), result: { kind: 'tooFar' } },
  { frame: frame('other', '2025-11-20T05:30:00Z'), result: { kind: 'outside', offset_deg: 1.879 } },
  { frame: frame('later', '2026-05-28T00:00:00Z'), result: { kind: 'fits', inside: ALL, hits: [1, 2], unknown: [], nearest: nearest(4.04, 45) } },
  { frame: frame('next', '2026-05-29T00:00:00Z'), result: { kind: 'fits', inside: [0, 1, 2, 3], hits: [2, 3], unknown: [3], nearest: nearest(6.2, 30, 'unknown') } },
  { frame: frame('last', '2026-05-30T00:00:00Z', 0.8), result: { kind: 'nothing', inside: [2, 3, 4], nearest: nearest(100, 12) } },
  { frame: frame('reload', '2026-05-31T00:00:00Z'), result: { kind: 'noSources' } },
]
const state = (change: Partial<DistantTrackState>): DistantTrackState => ({
  status: 'ready', range: [20, 2000], error: null, track: TRACK, rows, summary: summarizeDistant(rows, DISTANCES), retry: () => undefined, ...change,
})

describe('DistantTrackCheck', () => {
  it('leads with the distances that fit and keeps every image and the model in a closed disclosure', () => {
    const html = renderToStaticMarkup(<DistantTrackCheck state={state({})} />)
    expect(html).toContain('Distant-object track: fits 40 AU in 2 of 3 other images · outside the field in 1 more')
    expect(html).toMatch(/<details class="disclosure"><summary>Per image and model<\/summary>/)
    expect(html).toContain('2026-05-28 00:00 UTC · 25–40 AU · nearest detection 4.0″ (S/N 45, × No catalogue match – needs verification)')
    expect(html).toContain('2026-05-29 00:00 UTC · 40–100 AU · nearest detection 6.2″ (S/N 30, × Unknown – catalogue unavailable) · 2000 AU outside the field')
    expect(html).toContain('2026-05-30 00:00 UTC · none · nearest detection 1.7′ (S/N 12, × No catalogue match – needs verification) (frame only partly covered) · 20–25 AU outside the field')
    expect(html).toContain('2025-11-20 05:30 UTC · positions outside the field (nearest 1.9° from its centre)')
    expect(html).toContain('2026-05-31 00:00 UTC · no source list – reload this comparison')
    expect(html).toContain('2025-03-01 10:00 UTC · more than 400 days from the marks – not predicted')
    expect(html).toContain('with no Gaia DR3 or AllWISE match, or with no catalogue answer, inside a search circle (2σ, at least 1.5 pixels)')
    expect(html).toContain('straight-line heliocentric motion + Earth parallax · 5 assumed distances, 20–2000 AU, uniform in 1/d. Each hypothesis')
    expect(html).not.toContain('Beyond')
    expect(html).not.toMatch(/confirmed|discover/i)
  })

  it('says why the distances end early when the marks move too fast for anything farther', () => {
    const near = { ...TRACK, hypotheses: [20, 100, 276.6].map((distance_au) => ({ distance_au, points: [] })) }
    const html = renderToStaticMarkup(<DistantTrackCheck state={state({ track: near, rows: [] })} />)
    expect(html).toContain('3 assumed distances, 20–280 AU, uniform in 1/d. Beyond 280 AU no bound object moves as fast as the marks.')
  })

  it('says honestly while it waits, when the API fails, and why it does not ask', () => {
    expect(renderToStaticMarkup(<DistantTrackCheck state={state({ status: 'off' })} />)).toBe('')
    expect(renderToStaticMarkup(<DistantTrackCheck state={state({ status: 'loading', range: [20, 276.6] })} />))
      .toContain('role="status">Distant-object track: computing positions for 20–280 AU…')
    const failed = renderToStaticMarkup(<DistantTrackCheck state={state({ status: 'error', error: 'Request failed (422)' })} />)
    expect(failed).toContain('role="alert">Distant-object track unavailable: Request failed (422)')
    expect(failed).toContain('>Retry</button>')
    expect(renderToStaticMarkup(<DistantTrackCheck state={state({ status: 'tooFast' })} />))
      .toContain('Distant-object track: moves too fast for an object beyond 20 AU')
    expect(renderToStaticMarkup(<DistantTrackCheck state={state({ status: 'marksTooClose' })} />))
      .toContain('Distant-object track: needs marks more than 86 s apart')
  })

  it('names nothing found, hits without a catalogue answer, positions off the field and nothing checkable in one line', () => {
    expect(distantSummaryText({ kind: 'fits', ranges: [[20, 20], [100, 2000]], images: 1, checked: 2, outside: 0, unknownOnly: false }))
      .toBe('Distant-object track: fits 20 or 100–2000 AU in 1 of 2 other images')
    expect(distantSummaryText({ kind: 'fits', ranges: [[32.1, 39]], images: 1, checked: 1, outside: 1, unknownOnly: true }))
      .toBe('Distant-object track: fits 32–39 AU in 1 of 1 other image (catalogue unavailable for these detections) · outside the field in 1 more')
    expect(distantSummaryText({ kind: 'nothing', checked: 1, outside: 0 }))
      .toBe('Distant-object track: no uncatalogued detection on the possible positions inside the field in 1 other image')
    expect(distantSummaryText({ kind: 'outside', offset_deg: 0.15 }))
      .toBe('Distant-object track: possible positions leave this field (nearest 0.15° from its centre) – choose a larger region size')
    expect(distantSummaryText({ kind: 'outside', offset_deg: 1.2 }))
      .toBe('Distant-object track: possible positions leave this field (nearest 1.2° from its centre)')
    expect(distantSummaryText({ kind: 'unchecked' })).toBe('Distant-object track: no other image can be checked')
  })
})
