import type {
  DistantTrack,
  DistantTrackRequest,
  FingerprintJob,
  FingerprintRequest,
  FollowupJob,
  FollowupRequest,
  FrameJob,
  FrameRequest,
  NeossatCoverage,
  ObservationSummary,
  ResolvedTarget,
  SmallBodiesJob,
  SmallBodiesRequest,
  SpectrumJob,
  SpectrumRequest,
  SurpriseTarget,
} from './types'

// nginx answers these itself, with an HTML page, while the API is down or restarting.
const UNAVAILABLE = new Set([502, 503, 504])

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(120_000)
  // AbortSignal.any is missing before Chrome 116, Firefox 124 and Safari 17.4.
  const signal = init?.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([timeout, init.signal]) : init?.signal ?? timeout
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
    const message = !detail && UNAVAILABLE.has(response.status)
      ? 'The data service is not available right now. Retry in a moment.'
      : detail ?? `Request failed (${response.status})`
    throw Object.assign(new Error(message), { status: response.status })
  }
  return (await response.json()) as T
}

export const resolveName = (name: string, signal?: AbortSignal) =>
  request<ResolvedTarget>(`/api/resolve?${new URLSearchParams({ name })}`, { signal })

export const getSurprise = (signal?: AbortSignal) =>
  request<SurpriseTarget>('/api/surprise', { signal })

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

// Pure math, answered at once: positions for each assumed distance (not an orbit).
export const createDistantTrack = (body: DistantTrackRequest, signal?: AbortSignal) =>
  request<DistantTrack>('/api/track/distant', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// Forced photometry along a possible track at the other visits, measured by the worker.
export const createFollowup = (body: FollowupRequest, signal?: AbortSignal) =>
  request<FollowupJob>('/api/followup', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getFollowupJob = (jobId: string, signal?: AbortSignal) => request<FollowupJob>(`/api/followup/${jobId}`, { signal })

// The spectrum along one track of a follow-up, in the visits of every detector, measured by the worker.
export const createFingerprint = (body: FingerprintRequest, signal?: AbortSignal) =>
  request<FingerprintJob>('/api/followup/fingerprint', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const getFingerprintJob = (jobId: string, signal?: AbortSignal) =>
  request<FingerprintJob>(`/api/followup/fingerprint/${jobId}`, { signal })
