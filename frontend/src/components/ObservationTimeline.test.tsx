import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Frame, Observation } from '../types'
import { ObservationTimeline, epochRows, frameSpan } from './ObservationTimeline'

const obs = (id: string, detector: number, mjd: number): Observation => ({
  obs_id: id,
  detector,
  wavelength_min_um: 0.75,
  wavelength_max_um: 1.1,
  mjd,
  date: '2025-05-01T00:00:00',
  access_url: `https://irsa.example/${id}`,
})
const frame = (obsId: string, mjd: number, extra: Partial<Frame> = {}): Frame => ({
  index: 0,
  url: '/frames/x.png',
  obs_id: obsId,
  date: '2025-05-01T00:00:00',
  mjd,
  detector: 3,
  wavelength_min_um: 1.63,
  wavelength_max_um: 2.43,
  coverage: 1,
  source_url: 'https://irsa.example/cutout',
  epoch: 0,
  n_combined: 1,
  date_end: null,
  masked_fraction: null,
  wavelength_um: 2.0,
  bandwidth_um: 0.05,
  ...extra,
})
const OBSERVATIONS = [obs('a', 3, 60796), obs('b', 1, 60797), obs('c', 3, 60990)]

describe('ObservationTimeline', () => {
  it('counts visits per epoch and detector with the backend epoch rule', () => {
    expect(epochRows(OBSERVATIONS)).toEqual([
      { start: 60796, end: 60797, count: 2, perDetector: { 1: 1, 3: 1 } },
      { start: 60990, end: 60990, count: 1, perDetector: { 3: 1 } },
    ])
  })

  it('lets a stack span from its first exposure to date_end', () => {
    expect(frameSpan(frame('s', 60796, { date_end: '2025-05-03T00:00:00' }))).toEqual([
      60796, 60798,
    ])
    expect(frameSpan(frame('e', 60796))).toEqual([60796, 60796])
  })

  it('draws one dot per observation and marks the frames and the shown frame', () => {
    const html = renderToStaticMarkup(
      <ObservationTimeline
        observations={OBSERVATIONS}
        frames={[frame('a', 60796), frame('c', 60990)]}
        currentIndex={1}
        detector={3}
      />,
    )
    expect(html).toContain('role="img"')
    expect(html).toContain(
      'aria-label="3 SPHEREx observations from 2025-05-01 to 2025-11-11 in 2 epochs; 2 frames in this comparison; shown frame from 2025-11-11 on D3"',
    )
    expect(html.match(/<g class="viz-dots">.*?<\/g>/)![0].match(/<circle/g)).toHaveLength(3)
    expect(html.match(/class="viz-frame"/g)).toHaveLength(1)
    expect(html.match(/class="viz-frame shown"/g)).toHaveLength(1)
    expect(html).toContain('class="viz-row selected"')
    expect(html).toContain('Shown: 2025-05-01, D3, c')
    expect(html).toContain('◉</span> shown frame (2025-11-11)')
  })

  it('has a table fallback with the visits per epoch', () => {
    const html = renderToStaticMarkup(<ObservationTimeline observations={OBSERVATIONS} />)
    expect(html).toContain('<caption>SPHEREx observations per epoch and detector</caption>')
    expect(html).toContain('<th scope="row">2</th><td>2025-11-11</td><td>2025-11-11</td>')
    expect(html).not.toContain('frame in this comparison')
  })

  it('says so when nothing covers the position', () => {
    expect(renderToStaticMarkup(<ObservationTimeline observations={[]} />)).toContain(
      'No SPHEREx observations cover this position',
    )
  })
})
