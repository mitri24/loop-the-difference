import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CheckStep, pending } from './CheckStep'

const render = (current: boolean, status: Parameters<typeof CheckStep>[0]['status'] = { kind: 'done' }) => renderToStaticMarkup(
  <CheckStep n={2} status={status} current={current} summary="Track: 0.798″/h ± 0.03, PA 116°"><p>body</p></CheckStep>,
)

describe('CheckStep', () => {
  it('the current step is open and shows its body, not the summary line', () => {
    const html = render(true, { kind: 'active' })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('2 Possible track')
    expect(html).toContain('◐</span> in progress')
    expect(html).not.toContain('Track: 0.798')
    expect(html).not.toContain('hidden=""')
  })

  it('a finished step collapses to one summary line with the body hidden but mounted', () => {
    const html = render(false)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('✓</span> done')
    expect(html).toContain('<span class="check-step-summary">Track: 0.798″/h ± 0.03, PA 116°</span>')
    expect(html).toMatch(/aria-controls="([^"]+)".*<div id="\1" class="check-step-body" hidden="">\s*<p>body<\/p>/)
  })

  it('names why a step is not possible', () => {
    const html = render(false, { kind: 'blocked', reason: 'no significant motion' })
    expect(html).toContain('⊘</span> not possible: no significant motion')
    expect(render(false, { kind: 'todo' })).toContain('○</span> not started')
    expect([pending({ kind: 'todo' }), pending({ kind: 'active' }), pending({ kind: 'done' }), pending({ kind: 'blocked', reason: '' })])
      .toEqual([true, true, false, false])
  })
})
