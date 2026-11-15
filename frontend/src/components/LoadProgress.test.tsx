import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FrameJob } from '../types'
import { LoadProgress } from './LoadProgress'

const job = (progress: number, total: number): FrameJob =>
  ({ job_id: 'fixture', status: 'started', progress, total, manifest: null, error: null })

describe('LoadProgress', () => {
  it('is gone once nothing loads', () => {
    expect(renderToStaticMarkup(<LoadProgress busy={false} job={job(12, 12)} />)).toBe('')
  })

  it('only moves while the number of images is unknown', () => {
    const html = renderToStaticMarkup(<LoadProgress busy job={null} />)
    expect(html).toContain('class="load-progress searching"')
    expect(html).toContain('aria-valuetext="Loading SPHEREx images"')
    expect(html).not.toContain('aria-valuenow')
  })

  it('fills with the images fetched so far', () => {
    const html = renderToStaticMarkup(<LoadProgress busy job={job(5, 12)} />)
    expect(html).toContain('aria-valuenow="5"')
    expect(html).toContain('aria-valuemax="12"')
    expect(html).toContain('aria-valuetext="5 of 12 images loaded"')
    expect(html).toMatch(/width:41\.66/)
  })

  it('stays full while the final images are prepared', () => {
    expect(renderToStaticMarkup(<LoadProgress busy job={job(12, 12)} />)).toContain('class="load-progress finishing"')
    expect(renderToStaticMarkup(<LoadProgress busy job={job(14, 12)} />)).toContain('aria-valuenow="12"')
  })
})
