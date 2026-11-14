import { useEffect, useRef, useState } from 'react'
import { createSmallBodies, getSmallBodiesJob } from '../api'
import { MAX_GAP_DAYS, epochFor } from '../smallBodyLayer'
import type { SmallBodiesJob, SmallBodiesRequest, SmallBody, SmallBodyEpoch } from '../types'

const POLL_MS = 3000

interface State {
  key: string
  job: SmallBodiesJob | null
  error: string | null
}

/**
 * Lookup of known asteroids and comets for one request (target, frame size, one time per epoch).
 * A different request starts empty; the lookup itself starts on demand with `start`.
 */
export function useSmallBodies(request: SmallBodiesRequest | null) {
  const key = request ? JSON.stringify(request) : ''
  const [state, setState] = useState<State>({ key: '', job: null, error: null })
  const { job, error } = state.key === key ? state : { job: null, error: null }
  const running = job?.status === 'queued' || job?.status === 'started'

  useEffect(() => {
    if (!job || !running) return
    const timer = window.setTimeout(() => {
      getSmallBodiesJob(job.job_id).then(
        (next) => setState((old) => (old.key === key ? { ...old, job: next } : old)),
        (e: Error) => setState((old) => (old.key === key ? { key, job: null, error: e.message } : old)),
      )
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [job, running, key])

  const sending = useRef(false)
  const start = () => {
    if (!request || sending.current) return
    sending.current = true
    setState({ key, job: null, error: null })
    createSmallBodies(request)
      .then(
        (next) => setState((old) => (old.key === key ? { ...old, job: next } : old)),
        (e: Error) => setState((old) => (old.key === key ? { ...old, error: e.message } : old)),
      )
      .finally(() => (sending.current = false))
  }

  const epochs: SmallBodyEpoch[] = job?.status === 'finished' ? job.epochs : []
  return { ready: request != null, job, error, running, epochs, start }
}

export type SmallBodiesLookup = ReturnType<typeof useSmallBodies>

export const utc = (date: string) => date.replace('T', ' ').replace('Z', ' UTC')

export const motion = (body: SmallBody) => Math.hypot(body.ra_rate, body.dec_rate).toFixed(1)

export function progressText(job: SmallBodiesJob) {
  if (job.status === 'queued') return 'Waiting for a free lookup worker…'
  const done = job.total > 0 ? ` – ${job.progress} of ${job.total} epochs done` : ''
  return `JPL SBIdent: about 1 min per epoch, 3 at a time${done}`
}

// Every listed body is a catalogue match from JPL, never a detection in the SPHEREx frames.
export function SmallBodies({
  lookup,
  currentMjd,
}: {
  lookup: SmallBodiesLookup
  currentMjd: number | null
}) {
  const { ready, job, error, running, epochs, start } = lookup
  const shown = currentMjd == null ? null : epochFor(epochs, currentMjd)
  const failed = epochs.filter((epoch) => epoch.error != null).length

  return (
    <section className="small-bodies" aria-labelledby="small-bodies-title">
      <h3 id="small-bodies-title">Known asteroids and comets</h3>
      {!running && job?.status !== 'finished' && (
        <button type="button" onClick={start} disabled={!ready}>
          Look up known asteroids and comets (NASA/JPL)
        </button>
      )}
      {!ready && <p className="muted">Needs frames: the lookup uses their observation times.</p>}
      {job?.status === 'not_found' && <p className="notice">The lookup expired – look it up again.</p>}
      {running && job && (
        <p className="progress" role="status">
          {progressText(job)}
        </p>
      )}
      {(error ?? job?.error) && (
        <p className="notice error" role="alert">
          {error ?? job?.error}
        </p>
      )}
      {epochs.length > 0 && (
        <ol className="small-body-epochs">
          {epochs.map((epoch) => (
            <li key={epoch.mjd}>
              <p className="small-body-epoch">
                <time dateTime={epoch.date}>{utc(epoch.date)}</time>
                {epoch === shown && <strong> · markers on the shown frame</strong>}
                {' · '}
                <a href={epoch.source_url} target="_blank" rel="noreferrer">
                  JPL request
                </a>
              </p>
              {epoch.error ? (
                <p className="notice error">{epoch.error} – nothing is listed for this time.</p>
              ) : epoch.bodies.length === 0 ? (
                <p className="muted">No known asteroid or comet on the frame at this time.</p>
              ) : (
                <ul>
                  {epoch.bodies.map((body) => (
                    <li key={body.name}>
                      <span aria-hidden="true">◇ </span>
                      {body.name} · V {body.vmag == null ? 'n/a' : body.vmag.toFixed(1)} ·{' '}
                      {Math.round(body.distance_arcsec)}″ from the centre · moves {motion(body)}″/h
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {failed > 0 && !running && (
        <button type="button" onClick={start}>
          Ask JPL again for the {failed} {failed === 1 ? 'time' : 'times'} without an answer
        </button>
      )}
      {job?.status === 'finished' && (
        <p className="caveat">
          Known sources from NASA/JPL SBIdent, computed for the Earth&apos;s centre: SPHEREx orbits
          about 7,000 km from it, so positions shift by 5–10″ (1–2 SPHEREx pixels) for main-belt
          asteroids and by far more for close near-Earth objects. Markers ◇ appear on frames within{' '}
          {MAX_GAP_DAYS} day of a looked-up time, moved along JPL&apos;s rates. A marker is a
          catalogue match, not a detection; a moving source without one is a candidate that needs
          verification.
        </p>
      )}
    </section>
  )
}
