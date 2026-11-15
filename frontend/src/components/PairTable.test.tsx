import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../types'
import { PairTable, baselineText } from './PairTable'

const frame = (index: number, date: string, wavelength_um: number, extra: Partial<Frame> = {}): Frame => ({
  index, url: `/f/${index}.png`, obs_id: `obs-${index}`, date, mjd: 61000 + index * 90, detector: 6,
  wavelength_min_um: 4.41, wavelength_max_um: 5.01, coverage: 0.96, source_url: `https://irsa.example/obs-${index}`,
  epoch: index, n_combined: 1, date_end: null, masked_fraction: 0.012, wavelength_um, bandwidth_um: 0.04, ...extra,
})
const grid = { ra: 10, dec: 20, size_deg: 0.2, pixel_scale_arcsec: 6.15, collection: 'spherex_dr1' }
const noop = () => undefined
const table = (frames: Frame[], index = 0, letter: 'A' | 'B' | null = 'A') => renderToStaticMarkup(
  <PairTable frames={frames} pair={{ a: 0, b: 1 }} index={index} letter={letter} grid={grid} motion={null}
    onShow={noop} onChoose={noop} onSwap={noop} onSetShown={noop} />)

describe('PairTable', () => {
  it('puts every fact of A and B in the same row, with provenance links', () => {
    const html = table([frame(0, '2026-02-10T12:00:30Z', 4.61, { cloud_url: 'https://s3.example/0.fits' }),
      frame(1, '2026-05-11T12:00:00Z', 4.612, { n_combined: 6, release: 'QR3' })])
    expect(html).toContain('<th scope="row">Observed</th><td>2026-02-10 12:00:30 UTC</td><td>2026-05-11 12:00:00 UTC</td>')
    expect(html).toContain('<td>single exposure</td><td>stack of 6 exposures</td>')
    expect(html).toContain('<td>λ 4.610 µm ± 0.020</td><td>λ 4.612 µm ± 0.020</td>')
    expect(html).toContain('<td>96 %</td><td>96 %</td>')
    expect(html).toContain('href="https://irsa.example/obs-0"')
    expect(html).toContain('Level-2 file')
    expect(html).toContain('aria-label="Swap A and B"')
  })

  it('judges the pair: baseline, wavelength verdict with the shared rule, differing releases', () => {
    const same = table([frame(0, '2026-02-10T12:00:00Z', 4.61), frame(1, '2026-05-11T12:00:00Z', 4.612)])
    expect(same).toContain('class="pair-verdict ok"')
    expect(same).toContain('<strong>Δt 90.0 d</strong>')
    expect(same).toContain('same wavelength')
    // D6 resolves R = 128: 4.61 vs 4.64 µm is 0.65 %, more than half (0.39 %) but within one element (0.78 %).
    const close = table([frame(0, '2026-02-10T12:00:00Z', 4.61), frame(1, '2026-05-11T12:00:00Z', 4.64, { release: 'QR3' })])
    expect(close).toContain('class="pair-verdict warn"')
    expect(close).toContain('releases differ')
    const far = table([frame(0, '2026-02-10T12:00:00Z', 4.61), frame(1, '2026-05-11T12:00:00Z', 4.9)])
    expect(far).toContain('class="pair-verdict fail"')
  })

  it('lists the archive metadata of A and B, a dash where the archive lists none', () => {
    const exposure = frame(0, '2025-05-05T16:49:00Z', 4.61, {
      exposure_s: 113.5826, start_mjd: 60800.700028, end_mjd: 60800.701361, resolving_power: 127.8,
      spatial_resolution_arcsec: 3.075, calib_level: 2, instrument_name: 'SPHEREx', facility_name: 'SPHEREx',
      release_date: '2026-09-27T23:59:28Z', publisher_did: 'ivo://irsa.ipac/spherex_dr1?2025W19_1B_0116_1/D6',
    })
    // A stack of eight; a manifest from before pipeline 13 has none of the fields.
    const stack = frame(1, '2025-11-03T12:14:45Z', 4.612, { n_combined: 8, exposure_s: 908.6608, start_mjd: 60982.50957, end_mjd: 60986.21 })
    const dash = '<td><span class="muted">–</span></td>'
    const html = table([exposure, stack])
    expect(html).toContain('<td>2025-05-05 16:48:02 → 16:49:58 UTC (115 s)</td><td>2025-11-03 12:13 → 2025-11-07 05:02 UTC (3.7 d)</td>')
    expect(html).toContain('<td>113.6 s</td><td>8 × 113.6 s = 909 s</td>')
    expect(html).toContain(`<th scope="row" title="λ/Δλ as the archive lists it (em_res_power)">Resolving power</th><td>127.8</td>${dash}`)
    expect(html).toContain(`<td>3.075″</td>${dash}`)
    expect(html).toContain(`<td>2 · calibrated, science-ready</td>${dash}`)
    expect(html).toContain(`<td>SPHEREx</td>${dash}`)
    expect(html).toContain(`<td>2026-09-27</td>${dash}`)
    expect(html).toContain(`<td><code class="pair-id">ivo://irsa.ipac/spherex_dr1?2025W19_1B_0116_1/D6</code></td>${dash}`)
    const old = table([frame(0, '2026-02-10T12:00:00Z', 4.61), frame(1, '2026-05-11T12:00:00Z', 4.612)])
    expect(old.split(`${dash}${dash}`)).toHaveLength(9)
  })

  it('offers the shown frame as A or B when it is neither', () => {
    const frames = [frame(0, '2026-02-10T12:00:00Z', 4.61), frame(1, '2026-05-11T12:00:00Z', 4.612), frame(2, '2026-08-09T12:00:00Z', 4.62)]
    const html = table(frames, 2, null)
    expect(html).toContain('Showing frame 3 of 3')
    expect(html).toContain('title="Use observation 3 as A">Use as A</button>')
    expect(table(frames, 0, 'A')).not.toContain('Use as A')
  })

  it('writes long baselines in years', () => {
    expect(baselineText(30)).toBe('30.0 d')
    expect(baselineText(730.5)).toBe('2.00 yr')
  })
})
