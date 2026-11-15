import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SmallBodiesJob, SmallBodyEpoch } from '../types'
import { observerText } from '../smallBodyLayer'
import { SmallBodies, type SmallBodiesLookup, motion, progressText, utc } from './SmallBodies'

const body = {
  name: '(2016 GD49)',
  ra: 44.993791667,
  dec: 17.055305556,
  vmag: 22.5,
  ra_rate: -37.04,
  dec_rate: -11.78,
  distance_arcsec: 200.2,
}

const epoch = (mjd: number, extra: Partial<SmallBodyEpoch> = {}): SmallBodyEpoch => ({
  mjd,
  date: '2025-11-10T06:00:00Z',
  bodies: [body],
  error: null,
  source_url: 'https://ssd-api.jpl.nasa.gov/sb_ident.api?mpc-code=500',
  ...extra,
})

const job = (extra: Partial<SmallBodiesJob>): SmallBodiesJob => ({
  job_id: '0123456789abcdef',
  status: 'finished',
  progress: 0,
  total: 0,
  epochs: [],
  error: null,
  ...extra,
})

const lookup = (j: SmallBodiesJob | null, extra: Partial<SmallBodiesLookup> = {}) => ({
  ready: true,
  job: j,
  error: null,
  running: j?.status === 'queued' || j?.status === 'started',
  epochs: j?.status === 'finished' ? j.epochs : [],
  start: () => undefined,
  ...extra,
})

const render = (l: SmallBodiesLookup, currentMjd: number | null = null) =>
  renderToStaticMarkup(<SmallBodies lookup={l} currentMjd={currentMjd} />)

describe('SmallBodies', () => {
  it('offers the lookup only once frames give the times', () => {
    expect(render(lookup(null))).toContain('Look up known asteroids and comets (NASA/JPL)')
    const waiting = render(lookup(null, { ready: false }))
    expect(waiting).toContain('disabled')
    expect(waiting).toContain('Needs frames')
  })

  it('says how long JPL takes and how far it got', () => {
    const started = job({ status: 'started', progress: 2, total: 6 })

    expect(progressText(started)).toBe(
      'JPL SBIdent: about 1 min per epoch, 3 at a time – 2 of 6 epochs done',
    )
    expect(progressText(job({ status: 'queued' }))).toBe('Waiting for a free lookup worker…')
    expect(render(lookup(started))).toContain('role="status"')
  })

  it('lists each epoch with its bodies, an empty field and an unanswered time honestly', () => {
    const html = render(
      lookup(
        job({
          epochs: [
            epoch(60989.25),
            epoch(60990.25, { bodies: [] }),
            epoch(60991.25, { bodies: [], error: 'JPL SBIdent not reachable' }),
          ],
        }),
      ),
      60989.25,
    )

    expect(html).toContain('(2016 GD49) · V 22.5 · 200″ from the centre · moves 38.9″/h')
    expect(html).toContain('markers on the shown frame')
    expect(html).toContain('No known asteroid or comet on the frame at this time.')
    expect(html).toContain('JPL SBIdent not reachable – nothing is listed for this time.')
    expect(html).toContain('Ask JPL again for the 1 time without an answer')
    expect(html).toContain('href="https://ssd-api.jpl.nasa.gov/sb_ident.api?mpc-code=500"')
    expect(html).toContain('catalogue match, not a detection')
    expect(html).not.toMatch(/discover|confirmed|new object/i)
  })

  it('names the observer the request was made for: SPHEREx, else the Earth’s centre and why', () => {
    const fromSpherex = epoch(60989.25, {
      source_url: 'https://ssd-api.jpl.nasa.gov/sb_ident.api?xobs=2559.544%2C-1082.631%2C6444.070%2C0%2C0%2C0&obs-time=2460989.75000',
    })
    const html = render(lookup(job({ epochs: [fromSpherex, epoch(60990.25)] })))

    expect(observerText(fromSpherex)).toBe('seen from SPHEREx')
    expect(observerText(epoch(60990.25))).toBe('seen from the Earth’s centre – JPL Horizons gave no SPHEREx position')
    expect(html).toContain('06:00:00 UTC</time> · seen from SPHEREx')
    expect(html).toContain('UTC</time> · seen from the Earth’s centre – JPL Horizons gave no SPHEREx position')
    expect(html).toContain('seen from SPHEREx at each looked-up time')
    expect(html).toContain('typically a few ″, up to ~10″ (1.5 SPHEREx pixels) for main-belt')
    expect(html).not.toContain('5–10″')
  })

  it('formats dates and motion for reading', () => {
    expect(utc('2025-11-10T06:00:00Z')).toBe('2025-11-10 06:00:00 UTC')
    expect(motion(body)).toBe('38.9')
  })
})
