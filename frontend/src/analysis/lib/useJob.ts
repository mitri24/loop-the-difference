import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { JobStatus } from '../api/types'

/** Poll jobs with generation guards: cancelled or old targets cannot publish late results. */
export function useJob<R>() {
  const [job, setJob] = useState<JobStatus<R> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useRef<(() => void) | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    wake.current?.()
    wake.current = null
  }, [])
  const start = useCallback(async (launch: () => Promise<JobStatus<R>>) => {
    stop()
    const gen = ++generation.current
    setLaunching(true)
    setError(null)
    setJob(null)
    try {
      let current = await launch()
      if (gen !== generation.current) return
      setJob(current)
      setLaunching(false)
      while (current.state !== 'done' && current.state !== 'error') {
        await new Promise<void>(resolve => { wake.current = resolve; timer.current = setTimeout(resolve, 1200) })
        if (gen !== generation.current) return
        current = await api.job<R>(current.id)
        if (gen !== generation.current) return
        setJob(current)
      }
      if (current.state === 'error') setError(current.error ?? 'The job failed.')
    } catch (e) {
      if (gen === generation.current) setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      if (gen === generation.current) setLaunching(false)
    }
  }, [stop])
  const reset = useCallback(() => {
    generation.current++
    stop()
    setJob(null)
    setError(null)
    setLaunching(false)
  }, [stop])
  useEffect(() => () => { stop(); generation.current += 1 }, [stop])
  return { job, result: job?.state === 'done' ? job.result : null, error,
    running: launching || (job !== null && (job.state === 'queued' || job.state === 'running')), start, reset }
}
