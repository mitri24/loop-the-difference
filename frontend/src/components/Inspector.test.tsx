import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Inspector } from './Inspector'

describe('Inspector', () => {
  const tabs = [
    { id: 'frame', label: 'Frame', content: <p>frame panel</p> },
    { id: 'quality', label: 'Quality', count: 2, alert: true, content: <p>quality panel</p> },
    { id: 'coverage', label: 'Coverage', count: 258, content: <p>coverage panel</p> },
    { id: 'data', label: 'Data', count: 0, content: <p>data panel</p> },
  ]

  it('names every tab in order, selects one and keeps every panel mounted, the others hidden', () => {
    const html = renderToStaticMarkup(<Inspector tabs={tabs} active="quality" onSelect={() => undefined} />)
    expect(html.match(/role="tab"/g)).toHaveLength(4)
    expect(html).toContain('id="inspect-tab-quality" type="button" role="tab" data-testid="inspect-quality" aria-selected="true" aria-controls="inspect-panel-quality" tabindex="0"')
    expect(html).toContain('id="inspect-tab-frame" type="button" role="tab" data-testid="inspect-frame" aria-selected="false" aria-controls="inspect-panel-frame" tabindex="-1"')
    // Every panel is rendered (charts and jobs keep their state); only the selected one is shown.
    expect(html).toContain('<div id="inspect-panel-quality" role="tabpanel" aria-labelledby="inspect-tab-quality" class="inspector-panel" tabindex="0"><p>quality panel</p>')
    expect(html).toContain('<div id="inspect-panel-frame" role="tabpanel" aria-labelledby="inspect-tab-frame" class="inspector-panel" hidden="" tabindex="0"><p>frame panel</p>')
  })

  it('counts once beside the label, a blocking check by name, no badge for nothing', () => {
    const html = renderToStaticMarkup(<Inspector tabs={tabs} active="frame" onSelect={() => undefined} />)
    expect(html).toContain('class="tab-count alert" aria-label="2, blocking check">2</span>')
    expect(html).toContain('class="tab-count" aria-label="258">258</span>')
    expect(html).toContain('data-testid="inspect-data" aria-selected="false" aria-controls="inspect-panel-data" tabindex="-1">Data</button>')
  })

  it('is a sheet with a close button where one is asked for (phones), and can be hidden as a whole', () => {
    const sheet = renderToStaticMarkup(<Inspector id="inspector" tabs={tabs} active="frame" onSelect={() => undefined} open onClose={() => undefined} />)
    expect(sheet).toContain('<section id="inspector" class="inspector open" aria-label="Inspect">')
    expect(sheet).toContain('aria-label="Close inspect"')
    expect(renderToStaticMarkup(<Inspector tabs={tabs} active="frame" onSelect={() => undefined} hidden />)).toContain('aria-label="Inspect" hidden=""')
  })
})
