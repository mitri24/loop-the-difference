import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AladinInstance } from 'aladin-lite'
import { createFrames, getFrameJob, getObservations, getSurprise, resolveName } from './api'
import { AboutPanel } from './components/AboutPanel'
import { stampText, type BlinkLetter } from './blink'
import { BlinkPlayer } from './components/BlinkPlayer'
import { BottomBar } from './components/BottomBar'
import { CandidatePanel } from './components/CandidatePanel'
import { TrackCheck } from './components/TrackCheck'
import { useCandidate, useMarkLayer } from './candidate'
import { DataLinks } from './components/DataLinks'
import { EvidencePanel, hasBlocker, manifestChecks } from './components/EvidencePanel'
import { DataPanel } from './components/DataPanel'
import { DifferenceView } from './components/DifferenceView'
import { Dock } from './components/Dock'
import { FloatingPanel } from './components/FloatingPanel'
import { LayersSection } from './components/LayersSection'
import { ModeSwitch } from './components/ModeSwitch'
import { ObservationTimeline } from './components/ObservationTimeline'
import { SearchBar } from './components/SearchBar'
import { SkyFrame } from './components/SkyFrame'
import { SkyView } from './components/SkyView'
import { SmallBodies, useSmallBodies } from './components/SmallBodies'
import { SourceList } from './components/SourceList'
import { SpectrumChart } from './components/SpectrumChart'
import { TargetForm } from './components/TargetForm'
import { WavelengthStrip } from './components/WavelengthStrip'
import { useFrameLayers } from './frameLayers'
import { usePickLayer } from './pickLayer'
import { usePlateLayer } from './historicalPlate'
import { useMotionTrack } from './motionTrack'
import { checkFrames, possibleTrack } from './track'
import { useTrackLayer } from './trackLayer'
import { sliceForDetector } from './sky'
import { sliceText, useCubeWavelengths, useSkySlice } from './skyCube'
import { useSmallBodyLayer } from './smallBodyLayer'
import { countSources, useSourceLayer } from './sourceLayer'
import { CHALLENGE_TARGETS } from './targets'
import type { FrameJob, ObservationSummary, ProperMotion } from './types'
import { POLARIS, readEmbed, readQuery, toSearch, type TargetQuery, type ViewMode } from './url'

const INITIAL = readQuery(window.location.search)
const EMBED = readEmbed(window.location.search)
const POLARIS_CENTER = { ra: 37.954542, dec: 89.264111 }
const MAX_FRAMES = 12
const usesStacks = (mode: ViewMode) => mode !== 'exposures'
type Panel = 'target' | 'candidate' | 'evidence' | 'spectrum' | 'data' | 'layers' | 'about'
const PANELS: { id: Panel; title: string; label: string; icon: string }[] = [
  { id: 'target', title: 'Target & options', label: 'Target', icon: '⌖' },
  { id: 'candidate', title: 'Candidate check', label: 'Candidate', icon: '◎' },
  { id: 'evidence', title: 'Evidence & checks', label: 'Evidence', icon: '✓' },
  { id: 'spectrum', title: 'Spectrum & brightness', label: 'Spectrum', icon: '∿' },
  { id: 'data', title: 'Data & links', label: 'Data', icon: '⇲' },
  { id: 'layers', title: 'Sky layers', label: 'Layers', icon: '◫' },
  { id: 'about', title: 'About & credits', label: 'About', icon: 'i' },
]

export default function App() {
  const [query, setQuery] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [draft, setDraft] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [center, setCenter] = useState(POLARIS_CENTER)
  // The query the map was last moved to; a failed request leaves the map where it was.
  const [centred, setCentred] = useState<Pick<TargetQuery, 'ra' | 'dec'>>(POLARIS)
  const [summary, setSummary] = useState<ObservationSummary | null>(null)
  const [job, setJob] = useState<FrameJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [motion, setMotion] = useState<ProperMotion | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [status, setStatus] = useState('Choose a target or explore the map.')
  const [skyLayer, setSkyLayer] = useState('Loading sky survey…')
  const [skyUnavailable, setSkyUnavailable] = useState(false)
  const [sky, setSky] = useState<AladinInstance | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [seek, setSeek] = useState<{ index: number } | null>(null)
  const [frameLetter, setFrameLetter] = useState<BlinkLetter | null>(null)
  const showFrame = useCallback((index: number, letter: BlinkLetter | null) => {
    setFrameIndex(index)
    setFrameLetter(letter)
  }, [])
  const [framesOnSky, setFramesOnSky] = useState(true)
  const [sourcesOnSky, setSourcesOnSky] = useState(true)
  const [smallBodiesOnSky, setSmallBodiesOnSky] = useState(true)
  const [plateOnSky, setPlateOnSky] = useState(false)
  const [skySlice, setSkySlice] = useState(() => sliceForDetector((INITIAL ?? POLARIS).band))
  const [sliceBand, setSliceBand] = useState((INITIAL ?? POLARIS).band)
  const [viewRevision, setViewRevision] = useState(0)
  const [panel, setPanel] = useState<Panel | null>(INITIAL ? null : 'target')
  // Explore: the full sky to choose a region. Investigate: the SPHEREx images of that region.
  const [stage, setStage] = useState<'explore' | 'investigate'>(INITIAL ? 'investigate' : 'explore')
  const [pick, setPick] = useState<{ ra: number; dec: number } | null>(null)
  const [name, setName] = useState('')
  const [targetLabel, setTargetLabel] = useState(INITIAL ? INITIAL.name ?? 'Linked sky region' : 'Polaris')
  const [shareStatus, setShareStatus] = useState('')
  const controller = useRef<AbortController | null>(null)
  const lastRequest = useRef<{ query: TargetQuery; name?: string }>({ query: INITIAL ?? POLARIS })
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const panelTrigger = useRef<HTMLButtonElement | null>(null)

  const closePanel = useCallback(() => {
    setPanel(null)
    panelTrigger.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' &&
          !event.defaultPrevented && !(event.target instanceof HTMLSelectElement)) {
        closePanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePanel])

  const togglePanel = (next: Panel, trigger: HTMLButtonElement) => {
    panelTrigger.current = trigger
    if (panel === next) return closePanel()
    setPanel(next)
    window.setTimeout(() => panelHeading.current?.focus(), 0)
  }

  // knownMotion: the Gaia proper motion of requested.name, when it is already known.
  const run = useCallback(async (requested: TargetQuery, targetName?: string, knownMotion?: ProperMotion) => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    const signal = current.signal
    const stale = () => signal.aborted || controller.current !== current
    lastRequest.current = { query: requested, name: targetName }
    setBusy(true)
    setCancelled(false)
    setError(null)
    setJob(null)
    setSummary(null)
    setMotion(null)
    setPlateOnSky(false)
    setFrameIndex(0)
    setStage('investigate')
    setPick(null)
    // The images show the result; the target panel would cover them on small screens.
    setPanel((open) => (open === 'target' ? null : open))
    setName(targetName ?? requested.name ?? '')
    setStatus(targetName ? `Finding ${targetName}…` : 'Searching SPHEREx observations…')
    try {
      let next = requested
      let nextMotion = knownMotion ?? null
      if (targetName) {
        const target = await resolveName(targetName, signal)
        next = { ...requested, name: targetName, ra: target.ra.toFixed(6), dec: target.dec.toFixed(6) }
        nextMotion = target.proper_motion ?? null
      }
      if (stale()) return
      setQuery(next)
      setDraft(next)
      setMotion(nextMotion)
      setTargetLabel(next.name ?? CHALLENGE_TARGETS.find((t) => 'ra' in t && t.ra === next.ra && t.dec === next.dec)?.label ?? 'Selected sky region')
      window.history.replaceState(null, '', toSearch(next, EMBED))
      // A name in a shared link only adds the Gaia proper motion; the frames follow the coordinates.
      if (!targetName && next.name && !knownMotion) {
        resolveName(next.name, signal).then((target) => {
          if (!stale()) setMotion(target.proper_motion ?? null)
        }, () => undefined)
      }
      setStatus('Searching SPHEREx observations…')
      const [found, started] = await Promise.all([
        getObservations(next.ra, next.dec, signal),
        createFrames({ ra: next.ra, dec: next.dec, size_deg: next.fov, detector: next.band,
          max_frames: MAX_FRAMES, stack: usesStacks(next.mode) }, signal),
      ])
      if (stale()) return
      setSummary(found)
      setCenter({ ra: found.ra, dec: found.dec })
      setCentred(next)
      setViewRevision((value) => value + 1)
      let state = started
      setJob(state)
      const deadline = Date.now() + 10 * 60_000
      while (state.status === 'queued' || state.status === 'started') {
        if (Date.now() > deadline) throw new Error('The archive is taking too long. Retry or choose another region.')
        setStatus(state.status === 'started' && state.total > 0
          ? `Preparing cutouts · ${state.progress} of ${state.total}` : 'Waiting for SPHEREx cutouts…')
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        if (stale()) return
        state = await getFrameJob(state.job_id, signal)
        if (stale()) return
        setJob(state)
      }
      if (state.status === 'failed') throw new Error(state.error ?? 'Preparing the images failed. Please try again.')
      if (state.status === 'not_found') throw new Error('This comparison expired. Retry to prepare it again.')
      setStatus(state.manifest?.frames.length
        ? `${state.manifest.frames.length} images ready · ${state.manifest.epochs} epochs`
        : 'No usable images for this region and detector.')
    } catch (cause) {
      if (!stale()) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(cause instanceof DOMException && cause.name === 'TimeoutError'
          ? 'The data service timed out. Retry or choose another target.' : detail)
        setStatus('Could not load this comparison.')
        // Stop any parallel request after an error; the server may finish its cached job.
        current.abort()
      }
    } finally {
      if (controller.current === current) setBusy(false)
    }
  }, [])

  // New coordinates are not the named star any more; a new band, size or mode still is.
  const show = useCallback((next: TargetQuery) => {
    const same = next.ra === query.ra && next.dec === query.dec
    void run(same ? next : { ...next, name: undefined }, undefined, same ? motion ?? undefined : undefined)
  }, [run, query, motion])
  const find = useCallback((target: string, base: TargetQuery) => void run(base, target), [run])
  // The reason stays with the picked position, so it disappears when the user moves on.
  const [surprise, setSurprise] = useState<{ ra: string, dec: string, reason: string } | null>(null)
  const surpriseMe = useCallback(async () => {
    controller.current?.abort()
    const picking = new AbortController()
    controller.current = picking
    setBusy(true)
    setError(null)
    setJob(null)
    // The status line and any error live in the viewer.
    setStage('investigate')
    setStatus('Picking a fast-moving nearby star from Gaia DR3…')
    try {
      const star = await getSurprise(picking.signal)
      if (picking.signal.aborted) return
      const ra = star.ra.toFixed(6), dec = star.dec.toFixed(6)
      setSurprise({ ra, dec, reason: star.reason })
      void run({ ...draft, name: star.name, ra, dec }, undefined, star.proper_motion)
    } catch (cause) {
      if (picking.signal.aborted) return
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('Could not pick a star.')
    }
  }, [run, draft])
  const cancel = () => {
    controller.current?.abort()
    setBusy(false)
    setCancelled(true)
    setStatus('Stopped waiting. You can retry or choose another region.')
  }

  useEffect(() => {
    const timer = INITIAL ? window.setTimeout(() => void run(INITIAL), 0) : undefined
    return () => { window.clearTimeout(timer); controller.current?.abort() }
  }, [run])

  const selectMode = (mode: ViewMode) => {
    const next = { ...query, mode }
    setDraft((value) => ({ ...value, mode }))
    if (usesStacks(mode) !== usesStacks(query.mode) && (job || busy)) return show(next)
    setQuery(next)
    window.history.replaceState(null, '', toSearch(next, EMBED))
  }

  const useMapCenter = () => {
    const position = sky?.getRaDec()
    if (position) show({ ...draft, ra: position[0].toFixed(6), dec: position[1].toFixed(6) })
  }

  const share = async () => {
    try {
      await navigator.clipboard.writeText(new URL(toSearch(query, EMBED), window.location.href).href)
      setShareStatus('Comparison link copied')
    } catch {
      setShareStatus('Copy unavailable. Copy the address from your browser.')
    }
  }

  // SkyView jumps to the new detector's slice on a band change; the slider follows it.
  if (sliceBand !== query.band) {
    setSliceBand(query.band)
    setSkySlice(sliceForDetector(query.band))
  }
  const cubeActive = useSkySlice(sky, skySlice)
  const { wavelengths } = useCubeWavelengths()
  const skyCaption = cubeActive && skySlice !== sliceForDetector(query.band)
    ? `SPHEREx DR1 · ${sliceText(skySlice, wavelengths)}` : skyLayer

  const manifest = job?.manifest
  const checks = manifest ? manifestChecks(manifest) : []
  const differenceBlocked = manifest && (manifest.epochs < 2 || hasBlocker(checks, 'difference'))
    ? manifest.epochs < 2 ? 'At least two epochs are needed.' : 'Difference unavailable. See quality checks.'
    : undefined
  const showDifference = query.mode === 'difference' && !differenceBlocked && (manifest?.differences.length ?? 0) > 0
  const hasFrames = (manifest?.frames.length ?? 0) > 0
  // The player's frame blinks on the sky; the difference image stays in the panel.
  const frameLayers = useFrameLayers(sky, manifest, frameIndex, framesOnSky && !showDifference)
  useSourceLayer(sky, manifest?.frames, frameIndex, sourcesOnSky && hasFrames && !showDifference)
  const track = useMotionTrack(sky, motion, manifest?.frames)
  // The plate follows the field only once the map is centred on the current target.
  const plate = usePlateLayer(sky, plateOnSky, centred.ra === query.ra && centred.dec === query.dec ? center : null, motion)
  const frame = (hasFrames && manifest?.frames[frameIndex]) || null
  const counts = frame?.sources ? countSources(frame.sources) : null
  const sourceSummary = counts ? ` · ${counts.detected} in this frame · ${counts.none} ${counts.none === 1 ? 'needs' : 'need'} verification${counts.unknown ? ` · ${counts.unknown} unknown` : ''}` : ''
  const frameOnSky = frame && sky && framesOnSky && !showDifference ? frame : null
  const markBlocked = skyUnavailable ? 'The sky view needs WebGL2.'
    : showDifference ? 'Marks are set on single frames, not on the difference image.'
    : !frameOnSky ? 'Turn on "SPHEREx frames on the sky" in Layers to mark by clicking.' : null
  const candidate = useCandidate(job?.job_id ?? null, !markBlocked && panel === 'candidate')
  useMarkLayer(sky, candidate.marks)
  const possible = useMemo(() => manifest ? possibleTrack(candidate.marks, manifest, manifest.frames.map((f) => f.mjd)) : null, [candidate.marks, manifest])
  const predictions = useMemo(() => (showDifference ? [] : possible?.predictions ?? []), [possible, showDifference])
  useTrackLayer(sky, predictions)
  usePickLayer(sky, stage === 'explore' ? pick : null, draft.fov)
  // JPL SBIdent takes about a minute per time: one time per epoch, its first frame's.
  // A stack mixes exposures from up to 30 days: moving asteroids are looked up for single exposures.
  const smallBodies = useSmallBodies(manifest && hasFrames && !manifest.stacked ? {
    ra: `${manifest.ra}`, dec: `${manifest.dec}`, size_deg: manifest.size_deg,
    mjds: manifest.frames.filter((f, i, all) => all.findIndex((g) => g.epoch === f.epoch) === i).map((f) => f.mjd).slice(0, 6),
  } : null)
  useSmallBodyLayer(sky, smallBodies.epochs, frame?.mjd ?? null, smallBodiesOnSky)

  const statusBlock = (
    <>
      <div className="comparison-status" role="status" aria-live="polite">
        <span className={busy ? 'status-dot busy' : 'status-dot'} aria-hidden="true" />
        <span>{status}</span>
      </div>
      {busy && (
        <div className="loading-state">
          <progress aria-label="Preparing observations" {...(job && job.total > 0 ? { max: job.total, value: job.progress } : {})} />
          <p>Real observations are being fetched from IRSA. This can take a few minutes.</p>
          <button type="button" onClick={cancel}>Stop waiting</button>
        </div>
      )}
      {error && <div className="notice error" role="alert"><strong>Comparison unavailable</strong><p>{error}</p>
        {!EMBED && (centred.ra !== query.ra || centred.dec !== query.dec) && <p>The map still shows the previous position.</p>}</div>}
      {(!busy && (error || cancelled || (!hasFrames && job))) && (
        <div className="recovery-actions">
          <button type="button" onClick={() => void run(lastRequest.current.query, lastRequest.current.name)}>Retry</button>
          {!EMBED && <button type="button" onClick={() => { setStage('explore'); setPanel('target') }}>Choose another region</button>}
        </div>
      )}
    </>
  )
  const emptyState = !busy && !hasFrames && !error && !cancelled && (EMBED && !job
    ? <p className="muted">Add ra and dec to the URL, e.g. ?ra=02:31:49.09&amp;dec=+89:15:50.8&amp;embed=1</p>
    : <div className="empty-state">
      <span className="empty-reticle" aria-hidden="true" />
      <h3>{job ? 'No images to compare' : 'One region. Different moments.'}</h3>
      <p>{job ? 'Try another detector or sky region. Repeat coverage varies by position.' : 'Choose a target or use the map center to load real SPHEREx observations.'}</p>
      {!EMBED && <button type="button" onClick={useMapCenter} disabled={skyUnavailable || !sky}>Compare map center</button>}
    </div>)
  const modeSwitch = <ModeSwitch value={query.mode} onChange={selectMode} differenceBlocked={differenceBlocked} disabled={busy && !job} />
  const viewer = manifest && hasFrames && (
    <>
      {query.mode === 'difference' && differenceBlocked && <p className="notice">Difference unavailable. Showing epoch stacks. Open Evidence & checks for the reason.</p>}
      {query.mode === 'difference' && !differenceBlocked && !showDifference && <p className="notice">No difference image is available yet. Epoch stacks are shown below.</p>}
      {showDifference ? <DifferenceView key={job.job_id} manifest={manifest} />
        : <BlinkPlayer key={job.job_id} frames={manifest.frames} checks={checks} grid={manifest} motion={motion} predictions={predictions}
          onIndexChange={showFrame} seek={seek} active={EMBED || stage === 'investigate'} showShare={EMBED} />}
    </>
  )
  const qualityChecks = manifest && checks.length > 0 && <details className="disclosure" open={hasBlocker(checks, 'difference')}><summary>Quality checks · {checks.length}</summary><EvidencePanel checks={checks} /></details>
  const scienceNote = <p className="science-note">Changes are unverified. Wavelength, coverage and image artifacts can affect a comparison.</p>

  if (EMBED) return <main className="embed-workspace">{modeSwitch}{statusBlock}{emptyState}{viewer}{qualityChecks}{scienceNote}<p className="muted">SPHEREx · {manifest?.collection ?? summary?.collection ?? 'IRSA archive'}</p></main>

  const loadFirst = <p className="muted">Load a comparison first: choose a target in the search bar.</p>
  const dockItems = PANELS.map((item) => ({ ...item,
    count: item.id === 'candidate' ? candidate.marks.length : item.id === 'evidence' ? checks.length : undefined,
    alert: item.id === 'evidence' && checks.some((check) => check.severity === 'blocker' || check.severity === 'error') }))
  const current = PANELS.find((item) => item.id === panel)

  return (
    <div className="shell" data-testid="planet-x-shell">
      <a className="skip-link" href="#sky-map">Skip to the sky map</a>
      <SearchBar value={name} onChange={setName} draft={draft} busy={busy} onShow={show} onFind={find} onSurprise={() => void surpriseMe()} onShare={() => void share()} />

      <div className={`stage ${stage}`}>
        <section className="viewer" aria-label="SPHEREx images of the region" hidden={stage !== 'investigate'}>
          <div className="viewer-head">
            <button type="button" className="back-button" onClick={() => setStage('explore')}><span aria-hidden="true">←</span> Back to sky</button>
            <div className="target-summary"><strong>{targetLabel}</strong><span>D{query.band} · {query.fov}° region</span>
              {surprise?.ra === query.ra && surprise.dec === query.dec && <span className="muted">{surprise.reason}</span>}</div>
            {modeSwitch}
          </div>
          <div className="viewer-body">
            {statusBlock}
            {job && emptyState}
            {viewer}
            {hasFrames && scienceNote}
          </div>
        </section>
        <SkyFrame overview={stage === 'investigate'}>
          <main id="sky-map" className="sky-stage" tabIndex={0} aria-label="Interactive sky map. Arrow keys pan; plus and minus zoom." onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !sky) return
            const map = sky
            const [ra, dec] = map.getRaDec()
            const [fov] = map.getFov()
            const step = fov / 10
            // The same step on the sky east or west: RA degrees shrink with cos(Dec) towards the pole.
            const raStep = step / Math.max(Math.cos((dec * Math.PI) / 180), 0.01)
            if (event.key === 'ArrowLeft') map.gotoRaDec((((ra + raStep) % 360) + 360) % 360, dec)
            else if (event.key === 'ArrowRight') map.gotoRaDec((((ra - raStep) % 360) + 360) % 360, dec)
            else if (event.key === 'ArrowUp') map.gotoRaDec(ra, Math.min(90, dec + step))
            else if (event.key === 'ArrowDown') map.gotoRaDec(ra, Math.max(-90, dec - step))
            else if (event.key === '+' || event.key === '=') map.setFoV(Math.max(0.001, fov * 0.8))
            else if (event.key === '-') map.setFoV(Math.min(180, fov * 1.25))
            else return
            event.preventDefault()
          }} onClickCapture={(event) => {
            // Native Aladin menus get the workspace when opened, with no app panel obscuring them.
            if (event.target instanceof Element && event.target.closest('.aladin-widgets-toolbar, .aladin-projection-control, .aladin-fullScreen-control, .aladin-cooFrame, .aladin-location')) setPanel(null)
          }}>
            <SkyView ra={center.ra} dec={center.dec} fov={query.fov} detector={query.band} revision={viewRevision}
              onReady={(instance) => { setSky(instance); setSkyUnavailable(false) }}
              onLayerChange={setSkyLayer} onUnavailable={() => setSkyUnavailable(true)}
              onSkyClick={(ra, dec) => {
                if (candidate.armed && frameOnSky && manifest) candidate.markAt(frameOnSky, manifest, ra, dec)
                else if (stage === 'explore') setPick({ ra, dec })
              }} />
          </main>
          <footer className="map-caption">
            <div className="layer-caption"><span className="status-dot" aria-hidden="true" /><span>Sky context · {skyUnavailable ? 'WebGL2 unavailable' : skyCaption}</span></div>
            {frameOnSky && frameLayers[frameIndex] && <span className="frame-caption">{frameLayers[frameIndex] === 'failed'
              ? `SPHEREx frame ${frameIndex + 1}/${manifest!.frames.length} could not load on the sky`
              : `SPHEREx frame on the sky · ${stampText(frameOnSky, frameLetter)} · D${frameOnSky.detector} · ${frameIndex + 1}/${manifest!.frames.length}`}</span>}
            <span className="map-hint">Drag to explore · scroll to zoom · map tools at left</span>
          </footer>
        </SkyFrame>
        {stage === 'explore' && (pick || job) && <div className="explore-actions">
          {pick && <div className="pick-card" role="group" aria-label="Selected position">
            <span>RA {pick.ra.toFixed(5)}° · Dec {pick.dec.toFixed(5)}°</span>
            <button type="button" className="primary" onClick={() => show({ ...draft, ra: pick.ra.toFixed(6), dec: pick.dec.toFixed(6) })}>Compare here</button>
            <button type="button" aria-label="Clear the selected position" onClick={() => setPick(null)}>✕</button>
          </div>}
          {job && <button type="button" onClick={() => setStage('investigate')}>Back to {targetLabel} <span aria-hidden="true">→</span></button>}
        </div>}
      </div>

      {summary && <BottomBar hidden={stage !== 'investigate'} head={<strong>Observation timeline</strong>}>
        <ObservationTimeline observations={summary.observations} frames={manifest?.frames} currentIndex={showDifference ? undefined : frameIndex} detector={manifest?.detector ?? query.band} />
      </BottomBar>}

      <FloatingPanel hidden={!current} title={current?.title ?? ''} headingRef={panelHeading} onClose={closePanel}
        actions={panel === 'target' && <>
          <button type="submit" form="region-form" className="primary" disabled={busy}>Compare this position <span aria-hidden="true">→</span></button>
          <button type="button" onClick={useMapCenter} disabled={busy || skyUnavailable || !sky}>Use map center & compare</button>
        </>}>
        <section id="target-panel" hidden={panel !== 'target'}>
          <TargetForm value={draft} busy={busy} onShow={show} onFind={find} onChange={setDraft} />
          {!job && emptyState}
        </section>
        <section id="candidate-panel" hidden={panel !== 'candidate'}>
          {manifest && hasFrames ? <CandidatePanel candidate={candidate} blocked={markBlocked} track={possible && { ...possible, predictions }}
            known={{ epochs: smallBodies.epochs, motion, detector: manifest.detector, target: targetLabel }}
            visits={summary && { observations: summary.observations, inBlink: [...manifest.frames.map((f) => f.obs_id),
              ...manifest.differences.flatMap((d) => [...d.obs_ids_a, ...d.obs_ids_b])] }}>
            {possible && predictions.length > 0 && <TrackCheck checks={checkFrames({ ...possible, predictions }, manifest.frames, candidate.marks, manifest)}
              onShow={(index, p) => { setSeek({ index }); sky?.gotoRaDec(p.ra, p.dec) }} />}
          </CandidatePanel> : loadFirst}
          {!skyUnavailable && frame && !showDifference && <details className="disclosure">
            <summary>Detected sources{sourceSummary}</summary>
            <SourceList frame={frame} onSelect={(ra, dec) => sky?.gotoRaDec(ra, dec)} onMark={(source) => candidate.markSource(frame, source)} />
          </details>}
          {manifest && hasFrames && (manifest.stacked
            ? <p className="muted">Known asteroids and comets (JPL SBIdent) are looked up for single exposures: switch the view to Exposures.</p>
            : <SmallBodies lookup={smallBodies} currentMjd={frame?.mjd ?? null} />)}
        </section>
        <section id="evidence-panel" hidden={panel !== 'evidence'}>
          {manifest ? <EvidencePanel checks={checks} /> : loadFirst}
          {manifest && frame && !showDifference && <WavelengthStrip detector={manifest.detector} frame={frame} />}
          {scienceNote}
        </section>
        <section id="spectrum-panel" hidden={panel !== 'spectrum'} className="spectrum-section">
          {manifest ? <SpectrumChart key={`${manifest.ra},${manifest.dec}`} ra={`${manifest.ra}`} dec={`${manifest.dec}`}
            centerUm={(frame ?? manifest.frames[0])?.wavelength_um} detector={manifest.detector} /> : loadFirst}
        </section>
        <section id="data-panel" hidden={panel !== 'data'}>
          {manifest && hasFrames && <details className="disclosure" open><summary>Data & cross-check links</summary>
            <DataLinks manifest={manifest} frame={showDifference ? null : frame} /></details>}
          <DataPanel query={query} targetLabel={targetLabel} summary={summary} manifest={manifest} checks={checks}
            open={panel === 'data'} onAbout={() => setPanel('about')} />
        </section>
        <section id="layers-panel" hidden={panel !== 'layers'}>
          {skyUnavailable ? <p className="muted">Sky layers need WebGL2.</p> : <LayersSection aladin={sky} sizeDeg={query.fov} frame={frame}
            framesOnSky={framesOnSky} onFramesOnSkyChange={setFramesOnSky} sourcesOnSky={sourcesOnSky} onSourcesOnSkyChange={setSourcesOnSky}
            trackShown={track.length > 0} possibleTrackShown={predictions.length > 0} skySlice={skySlice} onSkySliceChange={setSkySlice} cubeActive={cubeActive}
            smallBodyEpochs={smallBodies.epochs} smallBodiesOnSky={smallBodiesOnSky} onSmallBodiesOnSkyChange={setSmallBodiesOnSky}
            plateAvailable={!!motion} plateOnSky={plateOnSky} onPlateOnSkyChange={setPlateOnSky} plate={plate}
            framesBlocked={showDifference ? 'The difference image is shown in the viewer. Frames and their detected sources go back on the sky in the other modes.' : undefined} />}
        </section>
        <section id="about-panel" hidden={panel !== 'about'}>
          <AboutPanel />
        </section>
      </FloatingPanel>

      <Dock items={dockItems} open={panel} onToggle={togglePanel} />
      {shareStatus && <div className="share-feedback" role="status"><span>{shareStatus}</span><button type="button" aria-label="Dismiss share message" onClick={() => setShareStatus('')}>×</button></div>}
    </div>
  )
}
