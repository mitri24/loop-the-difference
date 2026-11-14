import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FrameCheck } from '../track'
import type { DetectedSource, Frame } from '../types'
import { TrackCheck } from './TrackCheck'

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
  it('lists every other frame with one result, the summary and the caveat, never a verdict', () => {
    const html = renderToStaticMarkup(<TrackCheck checks={checks} onShow={() => undefined} />)
    expect(html).toContain('Consistent with the possible track in 1 of 2 other frames')
    expect(html).toContain('2026-05-12 07:45 UTC · RA 308.52543° Dec −22.89155° · r 9.2″ · ◎ detection 0.8″ from the prediction (S/N 177, × No catalogue match – needs verification)')
    expect(html).toContain('– nothing ≥5σ within 9.2″ (frame only partly covered)')
    expect(html).toContain('outside this frame')
    expect(html).toContain('no source list – reload this comparison')
    expect(html).toContain('2026-05-28 00:00 UTC · outside the straight-line window (see distance hypotheses)')
    expect(html.match(/Show on the sky/g)).toHaveLength(4)
    expect(html).toContain('A detection near a prediction can be another source; nothing ≥5σ can mean too faint.')
    expect(html).not.toMatch(/confirmed|found/i)
  })
  it('says when a frame holds only the brightest detections', () => {
    const full = { ...checks[1], frame: { ...checks[1].frame, coverage: 1, sources: Array(300).fill(source) } }
    const html = renderToStaticMarkup(<TrackCheck checks={[full]} onShow={() => undefined} />)
    expect(html).toContain('– nothing ≥5σ within 9.2″ (source list holds only the 300 brightest)')
  })
})
