import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeaderTools } from './HeaderTools'
import { SectionNav } from './SectionNav'

describe('SectionNav', () => {
  it('names every section in page order, marks the first and counts once, a blocking check by name', () => {
    const html = renderToStaticMarkup(<SectionNav page={createRef()} active sections={[
      { id: 'images', label: 'Images' },
      { id: 'checks', label: 'Checks', count: 2, alert: true },
      { id: 'coverage', label: 'Coverage', count: 258 },
      { id: 'data', label: 'Data & sources', count: 0 },
    ]} />)
    expect(html.match(/<a /g)).toHaveLength(4)
    expect(html).toContain('href="#images" data-testid="section-images" aria-current="true" title="Images (key 1)"')
    expect(html).toContain('class="section-count alert" aria-label="2, blocking check">2</span>')
    expect(html).toContain('class="section-count" aria-label="258">258</span>')
    // No badge for an empty count.
    expect(html).toContain('title="Data &amp; sources (key 4)">Data &amp; sources</a>')
  })
})

describe('HeaderTools', () => {
  it('offers the control sheets as buttons and folded into ⋯, the open one pressed', () => {
    const html = renderToStaticMarkup(<HeaderTools open="layers" onToggle={() => undefined} items={[
      { id: 'target', label: 'Options' }, { id: 'layers', label: 'Layers' }, { id: 'about', label: 'About' },
    ]} />)
    expect(html).toContain('data-testid="open-layers" aria-expanded="true"')
    expect(html).toContain('data-testid="menu-layers" aria-expanded="true"')
    expect(html).toContain('data-testid="header-more" aria-expanded="false"')
    expect(html).toContain('<div id="header-more-menu" class="header-more-menu" role="group" aria-label="More" hidden="">')
  })
})
