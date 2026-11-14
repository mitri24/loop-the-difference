import { useCallback, useEffect, useRef, useState } from 'react'
import type { AladinInstance } from 'aladin-lite'
import { createFrames, getFrameJob, getObservations, resolveName } from './api'
import { AboutPanel } from './components/AboutPanel'
import { BlinkPlayer } from './components/BlinkPlayer'
import { DataLinks } from './components/DataLinks'
import { EvidencePanel, hasBlocker, manifestChecks } from './components/EvidencePanel'
import { DataPanel } from './components/DataPanel'
import { DifferenceView } from './components/DifferenceView'
import { LayersSection } from './components/LayersSection'
import { ModeSwitch } from './components/ModeSwitch'
import { SkyView } from './components/SkyView'
import { SmallBodies, useSmallBodies } from './components/SmallBodies'
import { SourceList } from './components/SourceList'
import { TargetForm } from './components/TargetForm'
import { WavelengthStrip } from './components/WavelengthStrip'
import { useFrameLayers } from './frameLayers'
import { useMotionTrack } from './motionTrack'
import { sliceForDetector } from './sky'
import { sliceText, useCubeWavelengths, useSkySlice } from './skyCube'
import { useSmallBodyLayer } from './smallBodyLayer'
import { countSources, useSourceLayer } from './sourceLayer'
import type { FrameJob, ObservationSummary, ProperMotion } from './types'
import { POLARIS, readEmbed, readQuery, toSearch, type TargetQuery, type ViewMode } from './url'

const INITIAL = readQuery(window.location.search)
const EMBED = readEmbed(window.location.search)
const POLARIS_CENTER = { ra: 37.954542, dec: 89.264111 }
const MAX_FRAMES = 12
const usesStacks = (mode: ViewMode) => mode !== 'exposures'
type Panel = 'locate' | 'compare' | 'details'
const PANEL_TITLES: Record<Panel, string> = {
  locate: 'Find a sky region', compare: 'Compare observations', details: 'Data & evidence',
}

export default function App() {
  const [query, setQuery] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [draft, setDraft] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [center, setCenter] = useState(POLARIS_CENTER)
  const [summary, setSummary] = useState<ObservationSummary | null>(null)
  const [job, setJob] = useState<FrameJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [motion, setMotion] = useState<ProperMotion | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [status, setStatus] = useState('Choose a target or explore the map.')
  const [about, setAbout] = useState(false)
  const [skyLayer, setSkyLayer] = useState('Loading sky survey…')
  const [skyUnavailable, setSkyUnavailable] = useState(false)
  const [sky, setSky] = useState<AladinInstance | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [framesOnSky, setFramesOnSky] = useState(true)
  const [sourcesOnSky, setSourcesOnSky] = useState(true)
  const [smallBodiesOnSky, setSmallBodiesOnSky] = useState(true)
  const [skySlice, setSkySlice] = useState(() => sliceForDetector((INITIAL ?? POLARIS).band))
  const [sliceBand, setSliceBand] = useState((INITIAL ?? POLARIS).band)
  const [viewRevision, setViewRevision] = useState(0)
  const [panel, setPanel] = useState<Panel | null>(INITIAL ? 'compare' : 'locate')
  const [name, setName] = useState('')
  const [targetLabel, setTargetLabel] = useState(INITIAL ? INITIAL.name ?? 'Linked sky region' : 'Polaris')
  const [shareStatus, setShareStatus] = useState('')
  const controller = useRef<AbortController | null>(null)
  const lastRequest = useRef<{ query: TargetQuery; name?: string }>({ query: INITIAL ?? POLARIS })
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const panelTrigger = useRef<HTMLButtonElement | null>(null)
  const workspaceRoot = useRef<HTMLDivElement>(null)
  const appBar = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!appBar.current) return
    const observer = new ResizeObserver(([entry]) => {
      workspaceRoot.current?.style.setProperty('--bar-height', `${entry.target.getBoundingClientRect().height}px`)
    })
    observer.observe(appBar.current)
    return () => observer.disconnect()
  }, [])

  const closePanel = useCallback(() => {
    setPanel(null)
    panelTrigger.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]') &&
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
    setFrameIndex(0)
    setPanel('compare')
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
      setTargetLabel(next.name ?? (next.ra === POLARIS.ra && next.dec === POLARIS.dec ? 'Polaris' : 'Selected sky region'))
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
  useFrameLayers(sky, manifest, frameIndex, framesOnSky && !showDifference)
  useSourceLayer(sky, manifest?.frames, frameIndex, sourcesOnSky && hasFrames && !showDifference)
  const track = useMotionTrack(sky, motion, manifest?.frames)
  const frame = (hasFrames && manifest?.frames[frameIndex]) || null
  const counts = frame?.sources ? countSources(frame.sources) : null
  const sourceSummary = counts ? ` · ${counts.detected} in this frame · ${counts.none} ${counts.none === 1 ? 'needs' : 'need'} verification${counts.unknown ? ` · ${counts.unknown} unknown` : ''}` : ''
  const frameOnSky = frame && sky && framesOnSky && !showDifference ? frame : null
  // JPL SBIdent takes about a minute per time: one time per epoch, its first frame's.
  const smallBodies = useSmallBodies(manifest && hasFrames ? {
    ra: `${manifest.ra}`, dec: `${manifest.dec}`, size_deg: manifest.size_deg,
    mjds: manifest.frames.filter((f, i, all) => all.findIndex((g) => g.epoch === f.epoch) === i).map((f) => f.mjd).slice(0, 6),
  } : null)
  useSmallBodyLayer(sky, smallBodies.epochs, frame?.mjd ?? null, smallBodiesOnSky)

  const comparison = (
    <>
      <ModeSwitch value={query.mode} onChange={selectMode} differenceBlocked={differenceBlocked} />
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
      {error && <div className="notice error" role="alert"><strong>Comparison unavailable</strong><p>{error}</p></div>}
      {(!busy && (error || cancelled || (!hasFrames && job))) && (
        <div className="recovery-actions">
          <button type="button" onClick={() => void run(lastRequest.current.query, lastRequest.current.name)}>Retry</button>
          <button type="button" onClick={() => setPanel('locate')}>Choose another region</button>
        </div>
      )}
      {!busy && !hasFrames && !error && !cancelled && (
        <div className="empty-state">
          <span className="empty-reticle" aria-hidden="true" />
          <h3>{job ? 'No images to compare' : 'One region. Different moments.'}</h3>
          <p>{job ? 'Try another detector or sky region. Repeat coverage varies by position.' : 'Choose a target or use the map center to load real SPHEREx observations.'}</p>
          <button type="button" onClick={useMapCenter} disabled={skyUnavailable || !sky}>Compare map center</button>
        </div>
      )}
      {manifest && hasFrames && query.mode === 'difference' && (
        <>
          {differenceBlocked && <p className="notice">Difference unavailable. Showing epoch stacks. Open quality checks for the reason.</p>}
          {!differenceBlocked && !showDifference && <p className="notice">No difference image is available yet. Epoch stacks are shown below.</p>}
        </>
      )}
      {manifest && hasFrames && showDifference && <DifferenceView key={job.job_id} manifest={manifest} />}
      {manifest && hasFrames && !showDifference && <BlinkPlayer key={job.job_id} frames={manifest.frames} checks={checks} grid={manifest} motion={motion}
        onIndexChange={setFrameIndex} active={EMBED || panel === 'compare'} showShare={EMBED} />}
      {!EMBED && manifest && hasFrames && <details className="disclosure"><summary>Data & cross-check links</summary>
        <DataLinks manifest={manifest} frame={showDifference ? null : frame} /></details>}
      {!EMBED && manifest && frame && !showDifference && <WavelengthStrip detector={manifest.detector} frame={frame} />}
      {!EMBED && !skyUnavailable && <LayersSection aladin={sky} sizeDeg={query.fov} frame={frame}
        framesOnSky={framesOnSky} onFramesOnSkyChange={setFramesOnSky} sourcesOnSky={sourcesOnSky} onSourcesOnSkyChange={setSourcesOnSky}
        trackShown={track.length > 0} skySlice={skySlice} onSkySliceChange={setSkySlice} cubeActive={cubeActive}
        smallBodyEpochs={smallBodies.epochs} smallBodiesOnSky={smallBodiesOnSky} onSmallBodiesOnSkyChange={setSmallBodiesOnSky}
        framesBlocked={showDifference ? 'The difference image is shown in this panel. Frames and their detected sources go back on the sky in the other modes.' : undefined} />}
      {!EMBED && !skyUnavailable && frame && !showDifference && <details className="disclosure">
        <summary>Detected sources{sourceSummary}</summary>
        <SourceList frame={frame} onSelect={(ra, dec) => sky?.gotoRaDec(ra, dec)} />
      </details>}
      {!EMBED && manifest && hasFrames && <SmallBodies lookup={smallBodies} currentMjd={frame?.mjd ?? null} />}
      {manifest && checks.length > 0 && <details className="disclosure" open={hasBlocker(checks, 'difference')}><summary>Quality checks · {checks.length}</summary><EvidencePanel checks={checks} /></details>}
      <p className="science-note">Changes are unverified. Wavelength, coverage and image artifacts can affect a comparison.</p>
    </>
  )

  if (EMBED) return <main className="embed-workspace">{comparison}<p className="muted">SPHEREx · {manifest?.collection ?? summary?.collection ?? 'IRSA archive'}</p></main>

  return (
    <div ref={workspaceRoot} className={`workspace${panel ? ' sidebar-open' : ''}`} data-testid="planet-x-shell">
      <a className="skip-link" href="#workspace-tools">Skip to workspace controls</a>
      <main className="sky-stage" tabIndex={0} aria-label="Interactive sky map. Arrow keys pan; plus and minus zoom." onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !sky) return
        const map = sky
        const [ra, dec] = map.getRaDec()
        const [fov] = map.getFov()
        const step = fov / 10
        if (event.key === 'ArrowLeft') map.gotoRaDec((ra + step) % 360, dec)
        else if (event.key === 'ArrowRight') map.gotoRaDec((ra - step + 360) % 360, dec)
        else if (event.key === 'ArrowUp') map.gotoRaDec(ra, Math.min(90, dec + step))
        else if (event.key === 'ArrowDown') map.gotoRaDec(ra, Math.max(-90, dec - step))
        else if (event.key === '+' || event.key === '=') map.setFoV(Math.max(0.001, fov * 0.8))
        else if (event.key === '-') map.setFoV(Math.min(180, fov * 1.25))
        else return
        event.preventDefault()
      }} onClickCapture={(event) => {
        // Native Aladin menus get the workspace when opened, with no app sheet obscuring them.
        if (event.target instanceof Element && event.target.closest('.aladin-widgets-toolbar, .aladin-projection-control, .aladin-fullScreen-control, .aladin-cooFrame, .aladin-location')) setPanel(null)
      }}>
        <SkyView ra={center.ra} dec={center.dec} fov={query.fov} detector={query.band} revision={viewRevision}
          onReady={(instance) => { setSky(instance); setSkyUnavailable(false) }}
          onLayerChange={setSkyLayer} onUnavailable={() => setSkyUnavailable(true)} />
      </main>

      <header ref={appBar} className="app-bar" id="workspace-tools">
        <div className="brand"><span className="brand-mark" aria-hidden="true">＋</span><div><h1>Loop the Difference</h1><span>SPHEREx observation workspace</span></div></div>
        <form className="global-search" onSubmit={(event) => { event.preventDefault(); if (name.trim()) find(name.trim(), draft) }}>
          <label className="sr-only" htmlFor="sky-search">Find a sky object</label>
          <input id="sky-search" data-testid="sky-search" placeholder="Find a sky object…" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" disabled={busy || !name.trim()}>Find</button>
        </form>
        <nav className="workspace-nav" aria-label="Workspace">
          {(['locate', 'compare', 'details'] as const).map((item) => <button key={item} type="button"
            data-testid={`${item}-trigger`} aria-controls={`${item}-panel`} aria-expanded={panel === item}
            className={panel === item ? 'selected' : ''} onClick={(event) => togglePanel(item, event.currentTarget)}>
            {item === 'locate' ? 'Locate' : item === 'compare' ? 'Compare' : 'Data'}
            {item === 'compare' && busy && <span className="count" aria-label="Preparing observations">…</span>}
            {item === 'compare' && hasFrames && <span className="count">{manifest!.frames.length}</span>}
          </button>)}
        </nav>
        <div className="utility-actions"><button type="button" onClick={() => void share()} title="Copy this comparison link">Share</button><button type="button" onClick={() => setAbout(true)}>About</button></div>
      </header>

      <div className="sheet-position" hidden={!panel}>
        <aside className="workspace-sheet" aria-label={panel ? PANEL_TITLES[panel] : 'Workspace tools'}>
          <div className="sheet-header"><div><p className="eyebrow">{panel === 'locate' ? '01 / Locate' : panel === 'compare' ? '02 / Compare' : '03 / Inspect'}</p><h2 ref={panelHeading} tabIndex={-1}>{panel ? PANEL_TITLES[panel] : ''}</h2></div><button type="button" className="close-button" onClick={closePanel} aria-label="Close panel" title="Collapse sidebar">‹</button></div>
          <div className="sheet-content">
            <section id="locate-panel" hidden={panel !== 'locate'}>
              <p className="section-intro">Start with a familiar object, a precise position, or the center of your map.</p>
              <TargetForm value={draft} busy={busy} onShow={show} onFind={find} onChange={setDraft} />
            </section>
            <section id="compare-panel" hidden={panel !== 'compare'} className="comparison-content">
              <div className="target-summary"><strong>{targetLabel}</strong><span>D{query.band} · {query.fov}° region</span></div>
              {comparison}
            </section>
            <section id="details-panel" hidden={panel !== 'details'}>
              <DataPanel query={query} targetLabel={targetLabel} summary={summary} manifest={manifest} checks={checks}
                frameIndex={showDifference ? undefined : frameIndex} onAbout={() => setAbout(true)} />
            </section>
          </div>
          {panel === 'locate' && <div className="sheet-actions">
            <button type="submit" form="region-form" className="primary" disabled={busy}>Compare this position <span aria-hidden="true">→</span></button>
            <button type="button" onClick={useMapCenter} disabled={busy || skyUnavailable || !sky}>Use map center & compare</button>
          </div>}
        </aside>
      </div>

      <footer className="map-caption">
        <div className="layer-caption"><span className="status-dot" aria-hidden="true" /><span>Sky context · {skyUnavailable ? 'WebGL2 unavailable' : skyCaption}</span></div>
        {frameOnSky && <span className="frame-caption">SPHEREx frame on the sky · {frameOnSky.date.slice(0, 10)} · D{frameOnSky.detector} · {frameIndex + 1}/{manifest!.frames.length}</span>}
        <span className="map-hint">Drag to explore · scroll to zoom · map tools at left</span>
      </footer>
      {shareStatus && <div className="share-feedback" role="status"><span>{shareStatus}</span><button type="button" aria-label="Dismiss share message" onClick={() => setShareStatus('')}>×</button></div>}
      <AboutPanel open={about} onClose={() => setAbout(false)} />
    </div>
  )
}
