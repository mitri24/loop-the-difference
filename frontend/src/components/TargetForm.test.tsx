import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { POLARIS } from '../url'
import { TargetForm } from './TargetForm'

const noop = () => undefined

describe('TargetForm', () => {
  it('offers Pluto as a known moving object, never as a discovery', () => {
    const html = renderToStaticMarkup(
      <TargetForm value={POLARIS} busy={false} onShow={noop} onFind={noop} onChange={noop} />,
    )

    expect(html).toContain('Pluto · known dwarf planet (2026)')
    expect(html).toContain('an example with a known moving object')
    expect(html).not.toMatch(/discover|new object/i)
  })
})
