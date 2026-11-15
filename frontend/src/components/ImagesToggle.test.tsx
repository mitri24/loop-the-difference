import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImagesToggle } from './ImagesToggle'

const render = (value: 'exposures' | 'stacks', disabled = false) =>
  renderToStaticMarkup(<ImagesToggle value={value} onChange={() => undefined} disabled={disabled} />)

describe('ImagesToggle', () => {
  it('is one switch with two halves, the chosen one checked and focusable', () => {
    const html = render('exposures')
    expect(html).toContain('role="radiogroup" aria-label="Images"')
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Exposures</)
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>Stacks</)
  })

  it('writes what the chosen kind is good for under the switch, tied to it, not in a tooltip', () => {
    const exposures = render('exposures')
    expect(exposures).toContain('Best for motion.')
    expect(exposures).not.toContain('title=')
    const id = /aria-describedby="([^"]+)"/.exec(exposures)?.[1]
    expect(exposures).toContain(`<p class="images-hint" id="${id}">`)
    expect(render('stacks')).toContain('fainter sources show, but motion within an epoch smears')
  })

  it('disables both halves while the first comparison loads', () => {
    expect(render('stacks', true).match(/disabled=""/g)).toHaveLength(2)
  })
})
