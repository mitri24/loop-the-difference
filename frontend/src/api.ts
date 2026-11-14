import type { FrameJob, FrameRequest, ObservationSummary, ResolvedTarget } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : null
    throw new Error(detail ?? `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export const resolveName = (name: string) =>
  request<ResolvedTarget>(`/api/resolve?${new URLSearchParams({ name })}`)

export const getObservations = (ra: string, dec: string) =>
  request<ObservationSummary>(`/api/observations?${new URLSearchParams({ ra, dec })}`)

export const createFrames = (body: FrameRequest) =>
  request<FrameJob>('/api/frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getFrameJob = (jobId: string) => request<FrameJob>(`/api/frames/${jobId}`)
