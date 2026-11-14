import type {
  FrameJob,
  FrameRequest,
  NeossatCoverage,
  ObservationSummary,
  ResolvedTarget,
  SmallBodiesJob,
  SmallBodiesRequest,
  SpectrumJob,
  SpectrumRequest,
} from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(init?.signal ? [init.signal] : [])])
  let response: Response
  try {
    response = await fetch(path, { ...init, signal })
  } catch (cause) {
    if (cause instanceof TypeError) throw new Error('The data service could not be reached. Check your connection and retry.', { cause })
    throw cause
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : null
    throw new Error(detail ?? `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export const resolveName = (name: string, signal?: AbortSignal) =>
  request<ResolvedTarget>(`/api/resolve?${new URLSearchParams({ name })}`, { signal })

export const getObservations = (ra: string, dec: string, signal?: AbortSignal) =>
  request<ObservationSummary>(`/api/observations?${new URLSearchParams({ ra, dec })}`, { signal })

export const createFrames = (body: FrameRequest, signal?: AbortSignal) =>
  request<FrameJob>('/api/frames', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getFrameJob = (jobId: string, signal?: AbortSignal) =>
  request<FrameJob>(`/api/frames/${jobId}`, { signal })

export const createSpectrum = (body: SpectrumRequest) =>
  request<SpectrumJob>('/api/spectrum', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getSpectrumJob = (jobId: string) => request<SpectrumJob>(`/api/spectrum/${jobId}`)

// Known asteroids and comets per epoch (NASA/JPL SBIdent), looked up by the worker.
export const createSmallBodies = (body: SmallBodiesRequest) =>
  request<SmallBodiesJob>('/api/smallbodies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getSmallBodiesJob = (jobId: string) =>
  request<SmallBodiesJob>(`/api/smallbodies/${jobId}`)

export const getNeossat = (ra: string, dec: string) =>
  request<NeossatCoverage>(`/api/partners/neossat?${new URLSearchParams({ ra, dec })}`)
