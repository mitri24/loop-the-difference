import { useCallback, useEffect, useRef, useState } from 'react'
import { createFrames, getFrameJob, getObservations, resolveName } from './api'
import { AboutPanel } from './components/AboutPanel'
import { BlinkPlayer } from './components/BlinkPlayer'
import { EvidencePanel, hasBlocker, manifestChecks } from './components/EvidencePanel'
import { DifferenceView } from './components/DifferenceView'
import { ModeSwitch } from './components/ModeSwitch'
import { ObservationInfo } from './components/ObservationInfo'
import { SkyContext } from './components/SkyContext'
import { TargetForm } from './components/TargetForm'
import type { FrameJob, ObservationSummary } from './types'
import { POLARIS, readEmbed, readQuery, toSearch, type TargetQuery, type ViewMode } from './url'

const INITIAL = readQuery(window.location.search)
const EMBED = readEmbed(window.location.search)
const POLARIS_CENTER = { ra: 37.954542, dec: 89.264111 }
const MAX_FRAMES = 12
const POLL_MS = 1500

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const remember = (query: TargetQuery) =>
  window.history.replaceState(null, '', toSearch(query, EMBED))
// Stacks and the difference image are built from the same stacked job.
const usesStacks = (mode: ViewMode) => mode !== 'exposures'

export default function App() {
  const [query, setQuery] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [center, setCenter] = useState(POLARIS_CENTER)
  const [summary, setSummary] = useState<ObservationSummary | null>(null)
  const [job, setJob] = useState<FrameJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [about, setAbout] = useState(false)
  const latestRun = useRef(0)

  const show = useCallback(async (next: TargetQuery) => {
    const run = ++latestRun.current
    const stale = () => run !== latestRun.current
    setQuery(next)
    setSummary(null)
    setJob(null)
    setError(null)
    setBusy(true)
    remember(next)
    try {
      const [found, started] = await Promise.all([
        getObservations(next.ra, next.dec),
        createFrames({
          ra: next.ra,
          dec: next.dec,
          size_deg: next.fov,
          detector: next.band,
          max_frames: MAX_FRAMES,
          stack: usesStacks(next.mode),
        }),
      ])
      if (stale()) return
      setSummary(found)
      setCenter({ ra: found.ra, dec: found.dec })
      let state = started
      setJob(state)
      while (state.status === 'queued' || state.status === 'started') {
        await wait(POLL_MS)
        if (stale()) return
        state = await getFrameJob(state.job_id)
        if (stale()) return
        setJob(state)
      }
      if (state.status === 'failed') setError(state.error ?? 'Preparing the frames failed')
      if (state.status === 'not_found') setError('The frame job expired – please try again')
    } catch (e) {
      if (!stale()) setError(message(e))
    } finally {
      if (!stale()) setBusy(false)
    }
  }, [])

  const find = useCallback(
    async (name: string, base: TargetQuery) => {
      try {
        const target = await resolveName(name)
        await show({ ...base, ra: target.ra.toFixed(6), dec: target.dec.toFixed(6) })
      } catch (e) {
        setError(message(e))
      }
    },
    [show],
  )

  // Switching between stacks and difference reuses the frames already shown; only a change
  // of the stack flag needs a new job.
  const selectMode = useCallback(
    (mode: ViewMode) => {
      const next = { ...query, mode }
      if (usesStacks(mode) !== usesStacks(query.mode) && (job || busy)) return void show(next)
      setQuery(next)
      remember(next)
    },
    [query, job, busy, show],
  )

  // Coordinates in the URL (shared or embedded link): start right away.
  useEffect(() => {
    if (!INITIAL) return
    const timer = window.setTimeout(() => void show(INITIAL), 0)
    return () => window.clearTimeout(timer)
  }, [show])

  const manifest = job?.manifest
  const checks = manifest ? manifestChecks(manifest) : []
  const differenceBlocked =
    manifest && (manifest.epochs < 2 || hasBlocker(checks, 'difference'))
      ? 'Cannot compare epochs'
      : undefined
  // Until the worker delivers difference images (NAS-13) the stacks play with a note instead.
  const showDifference =
    query.mode === 'difference' && !differenceBlocked && (manifest?.differences.length ?? 0) > 0

  return (
    <div className="app">
      {!EMBED && (
        <header className="header">
          <div>
            <h1>Loop the Difference</h1>
            <p>See how the sky shifts: NASA SPHEREx images of one patch of sky, played over time.</p>
          </div>
          <button type="button" onClick={() => setAbout(true)}>
            About &amp; credits
          </button>
          <AboutPanel open={about} onClose={() => setAbout(false)} />
        </header>
      )}

      <main className={EMBED ? 'layout embed' : 'layout'}>
        {!EMBED && (
          <aside className="panel">
            <TargetForm
              key={toSearch(query)}
              value={query}
              busy={busy}
              onShow={show}
              onFind={find}
            />
            {summary && <ObservationInfo summary={summary} band={query.band} />}
          </aside>
        )}

        <section className="stage">
          {!EMBED && (
            <ModeSwitch
              value={query.mode}
              onChange={selectMode}
              differenceBlocked={differenceBlocked}
            />
          )}
          {error && <p className="notice error">{error}</p>}
          {manifest && <EvidencePanel checks={checks} />}
          {busy && (
            <p className="progress">
              {job?.status === 'started' && job.total > 0
                ? `Fetching SPHEREx cutouts… ${job.progress}/${job.total}`
                : 'Searching the SPHEREx archive…'}
            </p>
          )}
          {manifest && manifest.frames.length > 0 && query.mode === 'difference' && (
            <>
              {differenceBlocked && (
                <p className="notice">Cannot compare epochs: only one epoch covers this position.</p>
              )}
              {!differenceBlocked && !showDifference && (
                <p className="notice">
                  The difference image is still being built – meanwhile the epoch stacks play below.
                </p>
              )}
            </>
          )}
          {manifest && manifest.frames.length > 0 && showDifference && (
            <DifferenceView key={job.job_id} manifest={manifest} />
          )}
          {manifest && manifest.frames.length > 0 && !showDifference && (
            <BlinkPlayer key={job.job_id} frames={manifest.frames} checks={checks} />
          )}
          {!busy && !job && !error && (
            <p className="hint">
              {EMBED
                ? 'Add ra and dec to the URL, e.g. ?ra=02:31:49.09&dec=+89:15:50.8&embed=1'
                : 'Enter a sky position, or pick one of the challenge targets.'}
            </p>
          )}
          <p className="caveat">
            Loop the Difference is a discovery aid, not a detection pipeline: check every change against
            catalogues before calling it a candidate. SPHEREx observes through linear variable
            filters, so the exact wavelength differs from frame to frame.
          </p>
        </section>

        {!EMBED && (
          <section className="context">
            <h2>Sky context · AllWISE</h2>
            <SkyContext ra={center.ra} dec={center.dec} fov={query.fov} />
          </section>
        )}
      </main>

      <footer className="footer">
        Data: SPHEREx ({summary?.collection ?? 'spherex_dr1'}), NASA/IPAC Infrared Science Archive
        (IRSA) · {!EMBED && 'Sky context: Aladin Lite, CDS Strasbourg · '}Built for NASA Space Apps
        2026
      </footer>
    </div>
  )
}
