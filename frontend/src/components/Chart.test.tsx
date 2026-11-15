import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChartFrame, Marker, niceTicks, tickLabel } from './Chart'

describe('Chart', () => {
  it('labels large ticks compactly with as many decimals as the step needs', () => {
    expect(tickLabel(3_600_000, niceTicks([3_595_000, 3_650_000], 5))).toBe('3.60M')
    expect(tickLabel(3_605_000, { decimals: 0, step: 5_000 })).toBe('3.605M')
    expect(tickLabel(3_610_000, { decimals: 0, step: 5_000 })).not.toBe(tickLabel(3_605_000, { decimals: 0, step: 5_000 }))
    expect(tickLabel(125_000, { decimals: 0, step: 20_000 })).toBe('125K')
    expect(tickLabel(9_999, { decimals: 0, step: 1_000 })).toBe('9999')
    expect(tickLabel(-0.5, { decimals: 1, step: 0.5 })).toBe('-0.5')
  })

  it('keeps one tick for a flat domain', () => {
    expect(niceTicks([2, 2])).toEqual({ values: [2], decimals: 2, step: 0 })
  })

  it('draws every marker shape hollow for unreliable values, the cross included', () => {
    for (const shape of ['circle', 'square', 'triangle', 'diamond', 'triangle-down', 'plus'] as const) {
      const html = renderToStaticMarkup(<svg><Marker shape={shape} x={10} y={10} colour="var(--band-d2)" hollow /></svg>)
      expect(html).toContain('fill="var(--surface-1)"')
      expect(html).toContain('stroke="var(--band-d2)"')
    }
  })

  it('names the figure by its title, keeps one Table label and the table for screen readers', () => {
    const html = renderToStaticMarkup(
      <ChartFrame title="Flux over time" table={<table><caption>Flux per visit</caption></table>}>
        {(width) => <svg width={width} height={10} role="img" aria-label="chart" />}
      </ChartFrame>,
    )
    const id = /aria-labelledby="([^"]+)"/.exec(html)![1]
    expect(html).toContain(`<span class="viz-title" id="${id}">Flux over time</span>`)
    expect(html).toContain('aria-pressed="false">Table</button>')
    expect(html).toContain('<div class="viz-table"><table><caption>Flux per visit</caption></table></div>')
    // Drawn at the initial width until the browser measures the panel.
    expect(html).toContain('<svg width="320"')
  })
})
