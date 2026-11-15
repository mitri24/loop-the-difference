import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is a decorative grey frame in the shape of the content it stands for', () => {
    expect(renderToStaticMarkup(<Skeleton variant="image" />)).toBe('<span class="skeleton skeleton--image" aria-hidden="true"></span>')
    expect(renderToStaticMarkup(<Skeleton />)).toContain('skeleton--block')
  })

  it('stands for text with lines of varying width', () => {
    const html = renderToStaticMarkup(<Skeleton variant="line" lines={3} />)
    expect(html.match(/skeleton--line/g)).toHaveLength(3)
    expect(html).toContain('width:92%')
    expect(html).toContain('width:76%')
  })
})
