import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeaderTools } from './HeaderTools'

describe('HeaderTools actions', () => {
  it('offers Share after the sheets, as a button and folded into ⋯, and names it on the ⋯ button', () => {
    const html = renderToStaticMarkup(<HeaderTools open={null} onToggle={() => undefined} items={[{ id: 'layers', label: 'Layers' }]}
      actions={[{ id: 'share', label: 'Share', title: 'Copy this comparison link', onClick: () => undefined }]} />)
    expect(html).toContain('data-testid="action-share" title="Copy this comparison link">Share</button>')
    expect(html).toContain('data-testid="menu-share" title="Copy this comparison link">Share</button>')
    expect(html.indexOf('open-layers')).toBeLessThan(html.indexOf('action-share'))
    expect(html).toContain('aria-label="More: layers, share"')
  })
})
