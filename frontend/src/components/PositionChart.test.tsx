import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TRACK_LABEL } from '../motionTrack'
import { followPosition } from '../positionTrack'
import type { DetectedSource, Frame, ProperMotion } from '../types'
import { PositionChart } from './PositionChart'

const source = (ra: number, dec: number, extra: Partial<DetectedSource> = {}): DetectedSource => ({
  ra, dec, x: 0, y: 0, peak_mjy_sr: 1, snr: 40, match: 'gaia', catalog_id: 'Gaia DR3 4472832130942575872',
  separation_arcsec: 0.4, catalog_mag: 8.2, catalog_band: 'G', ...extra,
})
const frame = (obs_id: string, mjd: number, date: string, sources?: DetectedSource[]) =>
  ({ obs_id, mjd, date, detector: 6, source_url: `https://irsa.example/${obs_id}`, sources }) as Frame
const NORTH = 10 / 3600 / 365.25 // 10″ per year, in degrees per day

describe('PositionChart', () => {
  const frames = [
    frame('2025W20_1A_0001_1D6', 60800, '2025-05-12T00:00:00', [source(269.45, 4.74)]),
    frame('2025W46_1A_0002_1D6', 60990, '2025-11-18T00:00:00', [source(269.45, 4.74 + 190 * NORTH, { saturated: true })]),
    frame('2026W20_1A_0003_1D6', 61170, '2026-05-17T00:00:00', []),
    frame('2026W46_1A_0004_1D6', 61350, '2026-11-13T00:00:00', [source(269.45, 4.74 + 550 * NORTH)]),
  ]

  it('says the measured motion first, then draws east and north with their gaps, and lists every frame', () => {
    const track = followPosition(frames, { ra: 269.45, dec: 4.74 }, 6.15)
    const html = renderToStaticMarkup(<PositionChart track={track} subject="the target" detector={6} />)
    expect(html).toContain('Position of the target over time')
    expect(html).toMatch(/<p class="viz-result">Shifts 10\.0 ± \d\.\d\d″ per year in these frames<\/p>/)
    expect(html).toContain('East (″)')
    expect(html).toContain('North (″)')
    expect(html).toContain('saturated core, position less certain')
    expect(html).toContain('frame without a detection here')
    expect(html).toContain('no detection within 2 px (12″) of the expected position')
    expect(html).toContain('<td>2026-11-13</td><td>2026W46_1A_0004_1D6</td><td>+0.0</td><td>+15.1</td>')
    expect(html).toContain('href="https://irsa.example/2025W20_1A_0001_1D6"')
    expect(html).not.toContain(TRACK_LABEL)
    expect(html.toLowerCase()).not.toContain('discover')
  })

  it('draws the Gaia prediction dashed when the target has a proper motion', () => {
    const star: ProperMotion = {
      source_id: '1', ra: 269.45, dec: 4.74 - 3290 * NORTH, ref_epoch: 2016, pmra_mas_yr: 0, pmdec_mas_yr: 10000, parallax_mas: 547,
    }
    const track = followPosition(frames, { ra: 0, dec: 0 }, 6.15, star)
    const html = renderToStaticMarkup(<PositionChart track={track} subject="the target" detector={6} />)
    expect(html).toContain(TRACK_LABEL)
    expect(html).toContain('class="viz-predicted"')
    expect(html).toContain('Gaia DR3 predicts 10.0″ per year')
  })

  it('names why there is no chart, and offers the way back to the target', () => {
    const track = followPosition(frames.slice(0, 1), { ra: 269.45, dec: 4.74 }, 6.15)
    const html = renderToStaticMarkup(
      <PositionChart track={track} subject="the selected source" detector={6} onFollowTarget={() => undefined} />,
    )
    expect(html).toContain('Position of the selected source over time')
    expect(html).toContain('Fewer than two frames have a detection here: no position over time.')
    expect(html).toContain('>Follow the target again</button>')
    expect(html).not.toContain('<svg')
  })
})
