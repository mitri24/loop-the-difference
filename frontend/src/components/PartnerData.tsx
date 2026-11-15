import { useEffect, useRef, useState } from 'react'
import { Skeleton } from './Skeleton'
import { getNeossat } from '../api'
import type { NeossatCoverage } from '../types'

export type NeossatState =
  | { status: 'loading'; slow?: boolean }
  | { status: 'ready'; coverage: NeossatCoverage }
  | { status: 'error'; message: string }

// "619 observations, 2019" or "3 observations, 2019–2024"; null when no sky frame covers it.
export function neossatSummary(coverage: NeossatCoverage): string | null {
  if (coverage.count === 0) return null
  const noun = coverage.count === 1 ? 'observation' : 'observations'
  const first = coverage.first_date?.slice(0, 4)
  const last = coverage.last_date?.slice(0, 4)
  const years = first !== last ? `${first}–${last}` : first
  return years ? `${coverage.count} ${noun}, ${years}` : `${coverage.count} ${noun}`
}

// CADC needs up to ~50 s for some fields (R Dra); the API answers 504 meanwhile and fills its cache.
const SLOW_RETRIES = 6
const SLOW_RETRY_MS = 10_000

// One CADC lookup per position; retry asks again (the API joins a query that is still running).
export function useNeossat(ra: string, dec: string): { state: NeossatState; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const key = `${ra}|${dec}|${attempt}`
  const [result, setResult] = useState<{ key: string; state: NeossatState } | null>(null)
  const slow = useRef({ position: '', tries: 0 })

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const position = `${ra}|${dec}`
    if (slow.current.position !== position) slow.current = { position, tries: 0 }
    getNeossat(ra, dec).then(
      (coverage) => {
        if (current) setResult({ key, state: { status: 'ready', coverage } })
      },
      (e: Error & { status?: number }) => {
        if (!current) return
        if (e.status === 504 && slow.current.tries < SLOW_RETRIES) {
          slow.current.tries += 1
          setResult({ key, state: { status: 'loading', slow: true } })
          timer = setTimeout(() => setAttempt((n) => n + 1), SLOW_RETRY_MS)
          return
        }
        setResult({ key, state: { status: 'error', message: e.message } })
      },
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [ra, dec, key])

  return {
    state: result?.key === key ? result.state : { status: 'loading' },
    retry: () => setAttempt((n) => n + 1),
  }
}

export function NeossatLine({ state, onRetry }: { state: NeossatState; onRetry: () => void }) {
  if (state.status === 'loading') {
    return (
      <div aria-busy="true">
        <p role="status" className="muted">
          NEOSSat (CSA):{' '}
          {state.slow ? 'CADC is slow for this field – asking again…' : <span className="sr-only">checking the CADC archive…</span>}
        </p>
        {!state.slow && <Skeleton variant="line" />}
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="notice error" role="alert">
        <p>NEOSSat (CSA): {state.message}</p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }
  const summary = neossatSummary(state.coverage)
  if (!summary) {
    return <p role="status">NEOSSat (CSA): no NEOSSat observations cover this position</p>
  }
  return (
    <p role="status">
      NEOSSat (CSA): {summary}{' '}
      <span className="muted">· visible light, not comparable with SPHEREx ·</span>{' '}
      <a
        href={state.coverage.search_url}
        target="_blank"
        rel="noreferrer"
        aria-label="Open at CADC (opens in a new tab)"
      >
        Open at CADC
      </a>
    </p>
  )
}

// Partner-agency data for the current target; key by target like the spectrum.
export function PartnerData({ ra, dec }: { ra: string; dec: string }) {
  const { state, retry } = useNeossat(ra, dec)
  return (
    <section className="partner-data" aria-label="Partner-agency data">
      <NeossatLine state={state} onRetry={retry} />
    </section>
  )
}
