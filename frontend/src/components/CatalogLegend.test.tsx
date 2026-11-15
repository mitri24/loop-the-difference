import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CatalogLegend } from './CatalogLegend'

describe('CatalogLegend', () => {
  it('says that SkyBoT places asteroids as seen from the Earth’s centre, not from SPHEREx', () => {
    const html = renderToStaticMarkup(<CatalogLegend aladin={null} sizeDeg={0.2} frameMjd={60800} />)

    expect(html).toContain('asteroids, seen from the Earth’s centre')
  })
})
