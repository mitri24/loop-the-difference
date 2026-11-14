import type { Check, FrameJob } from '../types'

export type StatusKind = 'idle' | 'searching' | 'building' | 'done' | 'no-coverage' | 'few-epochs' | 'partial' | 'unreachable' | 'failed' | 'stopped'

export interface ComparisonState {
  busy: boolean
  job: FrameJob | null
  error: string | null
  cancelled: boolean
  checks: Check[]
  // The running step in words, e.g. "Finding Polaris…" or "7 images ready · 3 epochs".
  message: string
}

export interface ComparisonStatus {
  kind: StatusKind
  tone: 'busy' | 'ok' | 'warn' | 'fail' | 'idle'
  icon: string
  word: string
  text: string
  percent?: number
}

// Messages from api.ts, App.tsx and the backend (archive.py, main.py) when a service did not answer.
const UNREACHABLE = /not reachable|could not be reached|not available|timed out|taking too long|busy/i
const ARCHIVE = /archive|IRSA/i
const FEW_EPOCHS = ['SINGLE_EPOCH', 'NO_TIME_BASELINE']
const MISSING = ['CUTOUT_MISSING', 'RELEASE_UNAVAILABLE']

// One place that names the state of the current comparison; icon plus word, never colour alone.
export function comparisonStatus({ busy, job, error, cancelled, checks, message }: ComparisonState): ComparisonStatus {
  if (error) return UNREACHABLE.test(error)
    ? { kind: 'unreachable', tone: 'fail', icon: '✕', word: ARCHIVE.test(error) ? 'Archive unreachable' : 'Service unavailable', text: error }
    : { kind: 'failed', tone: 'fail', icon: '✕', word: 'Could not load', text: error }
  if (cancelled) return { kind: 'stopped', tone: 'warn', icon: '■', word: 'Stopped', text: message }
  if (busy && !job) return { kind: 'searching', tone: 'busy', icon: '⌕', word: 'Searching the archive', text: message }
  if (busy && job) return { kind: 'building', tone: 'busy', icon: '◔', word: 'Building frames', text: message,
    percent: job.total > 0 ? Math.round((100 * job.progress) / job.total) : undefined }
  const manifest = job?.manifest
  if (!manifest) return { kind: 'idle', tone: 'idle', icon: '○', word: 'Ready', text: message }
  if (manifest.frames.length === 0) return { kind: 'no-coverage', tone: 'warn', icon: '∅', word: 'No coverage', text: message }
  const missing = checks.filter((check) => MISSING.includes(check.code)).length
  if (manifest.epochs < 2 || checks.some((check) => FEW_EPOCHS.includes(check.code))) {
    return { kind: 'few-epochs', tone: 'warn', icon: '△', word: 'Too few epochs', text: message }
  }
  if (missing > 0) return { kind: 'partial', tone: 'warn', icon: '◐', word: 'Partial',
    text: `${message} · ${missing} archive ${missing === 1 ? 'request' : 'requests'} failed` }
  return { kind: 'done', tone: 'ok', icon: '✓', word: 'Done', text: message }
}

interface Props {
  status: ComparisonStatus
  onStop: () => void
  onRetry: () => void
  onChooseAnother?: () => void
  onDetails?: (trigger: HTMLButtonElement) => void
}

// The compact status line under the search bar: the current job, its result and what to do next.
export function StatusLine({ status, onStop, onRetry, onChooseAnother, onDetails }: Props) {
  const { kind, tone, icon, word, text, percent } = status
  const failed = tone === 'fail'
  const recover = !['idle', 'searching', 'building', 'done'].includes(kind)
  return (
    <div className={`status-line status-line--${tone}`} data-kind={kind}>
      <div className="status-text" role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>
        <span className="status-chip"><span aria-hidden="true">{icon}</span> {word}{percent != null && ` · ${percent} %`}</span>
        <span className="status-message">{text}</span>
      </div>
      {tone === 'busy' && <progress aria-label={word} {...(percent != null ? { max: 100, value: percent } : {})} />}
      {tone === 'busy' && <button type="button" className="chip" onClick={onStop}>Stop waiting</button>}
      {recover && kind !== 'no-coverage' && <button type="button" className="chip" onClick={onRetry}>Retry</button>}
      {recover && onChooseAnother && <button type="button" className="chip" onClick={onChooseAnother}>Choose another region</button>}
      {recover && !failed && kind !== 'stopped' && onDetails && <button type="button" className="chip" onClick={(event) => onDetails(event.currentTarget)}>Details</button>}
    </div>
  )
}
