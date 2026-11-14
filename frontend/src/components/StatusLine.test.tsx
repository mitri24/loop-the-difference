import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Check, FrameJob, FrameManifest } from '../types'
import { comparisonStatus, StatusLine, type ComparisonState } from './StatusLine'

const manifest = (frames: number, epochs: number) => ({ frames: Array.from({ length: frames }, () => ({})), epochs }) as unknown as FrameManifest
const job = (status: FrameJob['status'], m: FrameManifest | null = null, progress = 0, total = 0): FrameJob =>
  ({ job_id: 'j', status, progress, total, manifest: m, error: null })
const check = (code: string): Check => ({ code, severity: 'warning', message: code, detail: '', affects: [] })
const base: ComparisonState = { busy: false, job: null, error: null, cancelled: false, checks: [], message: 'msg' }
const kind = (state: Partial<ComparisonState>) => comparisonStatus({ ...base, ...state }).kind

describe('comparisonStatus', () => {
  it('names every state of a comparison', () => {
    expect(kind({})).toBe('idle')
    expect(kind({ busy: true })).toBe('searching')
    expect(kind({ busy: true, job: job('started', null, 3, 12) })).toBe('building')
    expect(kind({ job: job('finished', manifest(4, 2)) })).toBe('done')
    expect(kind({ job: job('finished', manifest(0, 0)) })).toBe('no-coverage')
    expect(kind({ job: job('finished', manifest(1, 1)), checks: [check('SINGLE_EPOCH')] })).toBe('few-epochs')
    expect(kind({ job: job('finished', manifest(4, 2)), checks: [check('CUTOUT_MISSING')] })).toBe('partial')
    expect(kind({ error: 'The data service could not be reached. Check your connection and retry.' })).toBe('unreachable')
    expect(kind({ error: 'Unknown target: x' })).toBe('failed')
    expect(kind({ cancelled: true })).toBe('stopped')
  })
  it('names the failing service from the real error messages', () => {
    const word = (error: string) => comparisonStatus({ ...base, error }).word
    expect(word('SPHEREx archive (IRSA) is not reachable')).toBe('Archive unreachable')
    expect(word('The archive is taking too long. Retry or choose another region.')).toBe('Archive unreachable')
    expect(word('The data service is not available right now. Retry in a moment.')).toBe('Service unavailable')
    expect(word('The data service could not be reached. Check your connection and retry.')).toBe('Service unavailable')
    expect(word('Job queue is not available')).toBe('Service unavailable')
    expect(word('Busy – please try again in a minute')).toBe('Service unavailable')
    expect(word('Name lookup timed out – try coordinates')).toBe('Service unavailable')
    expect(word('Invalid right ascension')).toBe('Could not load')
  })
  it('shows the build progress in per cent', () => {
    expect(comparisonStatus({ ...base, busy: true, job: job('started', null, 3, 12) }).percent).toBe(25)
    expect(comparisonStatus({ ...base, busy: true, job: job('queued') }).percent).toBeUndefined()
  })
  it('counts the failed archive requests of a partial result', () => {
    const status = comparisonStatus({ ...base, job: job('finished', manifest(4, 2)), checks: [check('CUTOUT_MISSING'), check('RELEASE_UNAVAILABLE')] })
    expect(status.text).toBe('msg · 2 archive requests failed')
  })
})

describe('StatusLine', () => {
  const render = (state: Partial<ComparisonState>) => renderToStaticMarkup(<StatusLine status={comparisonStatus({ ...base, ...state })}
    onStop={() => undefined} onRetry={() => undefined} onChooseAnother={() => undefined} onDetails={() => undefined} />)
  it('announces errors as an alert with what failed and how to recover', () => {
    const html = render({ error: 'SPHEREx archive (IRSA) is not reachable' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Archive unreachable')
    expect(html).toContain('IRSA) is not reachable')
    expect(html).toContain('>Retry<')
    expect(html).toContain('Choose another region')
  })
  it('offers stop while busy and details for a partial result', () => {
    expect(render({ busy: true, job: job('started', null, 1, 4) })).toContain('Stop waiting')
    expect(render({ busy: true, job: job('started', null, 1, 4) })).toContain('aria-live="polite"')
    const partial = render({ job: job('finished', manifest(4, 2)), checks: [check('CUTOUT_MISSING')] })
    expect(partial).toContain('Details')
    expect(partial).toContain('>Retry<')
    expect(render({ job: job('finished', manifest(4, 2)) })).not.toContain('Retry')
  })
})
