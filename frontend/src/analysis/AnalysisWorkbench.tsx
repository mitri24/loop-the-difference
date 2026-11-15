import { useCallback, useEffect, useRef, useState } from 'react'
import type { AladinInstance, ImageLayer, GraphicOverlay } from 'aladin-lite'
import { api, API_BASE } from './api/client'
import type { BandName, DifferenceResult, Mode, ObservationSearch, SequenceResult, SpectrumResult, Target } from './api/types'
import { BlinkPlayer } from './components/BlinkPlayer'
import { DifferencePanel } from './components/DifferencePanel'
import { EvidencePanel } from './components/EvidencePanel'
import { ObservationsPanel } from './components/ObservationsPanel'
import { SpectrumPanel, Progress } from './components/SpectrumPanel'
import { parsePolygon } from './lib/astro'
import { useJob } from './lib/useJob'
import './tokens.css'
import './components.css'
import './integration.css'

export type AnalysisView = 'blink' | 'difference' | 'observations' | 'spectrum' | 'evidence' | 'layers'
interface Props {
  target: Target
  detector: number
  fovDegrees: number
  view: AnalysisView | null
  sky: AladinInstance | null
  onSkyCaption: (caption: string | null) => void
}

/** Reference algorithms, sharing the host's target and menu; no second application shell. */
export function AnalysisWorkbench({ target, detector, fovDegrees, view, sky, onSkyCaption }: Props) {
  const [search, setSearch] = useState<ObservationSearch | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('matched')
  const [fov, setFov] = useState(Math.min(30, Math.max(2, fovDegrees * 60)))
  const [index, setIndex] = useState(0)
  const [showFootprints, setShowFootprints] = useState(false)
  const [showOnSky, setShowOnSky] = useState(false)
  const [difference, setDifference] = useState<DifferenceResult | null>(null)
  const sequence = useJob<SequenceResult>()
  const spectrum = useJob<SpectrumResult>()
  const generation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const band = `D${detector}` as BandName
  const load = useCallback(async () => {
    const gen = ++generation.current
    setSearching(true)
    setError(null)
    try {
      const result = await api.observations(target, fov)
      if (mounted.current && gen === generation.current) setSearch(result)
    } catch (e) {
      if (mounted.current && gen === generation.current) setError(String(e instanceof Error ? e.message : e))
    } finally {
      if (mounted.current && gen === generation.current) setSearching(false)
    }
  }, [target, fov])
  // Opening an analysis performs a metadata search only; downloads require an explicit action.
  useEffect(() => {
    if (!view || search || searching || error) return
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [view, search, searching, error, load])

  const build = () => {
    setIndex(0)
    setDifference(null)
    void sequence.start(() => api.startSequence({
      ra: target.ra, dec: target.dec, name: target.name,
      pm_ra_mas_yr: target.pm_ra_mas_yr, pm_dec_mas_yr: target.pm_dec_mas_yr,
      target_epoch_jyear: target.epoch_jyear, band, fov_arcmin: fov, mode,
    }))
  }
  const result = sequence.result
  const frames = result?.frames
  const currentFrame = frames?.[index]
  const overlay = view === 'blink' && showOnSky && currentFrame ? currentFrame : null
  useEffect(() => {
    if (!overlay || !sky) return
    const name = `reference-analysis-${overlay.id}`
    let disposed = false
    let added: ImageLayer | undefined
    const run = async () => {
      const { default: A } = await import('aladin-lite')
      if (disposed) return
      added = A.image(API_BASE + overlay.fits_url, {
        imgFormat: 'fits', name: `Analysis · ${overlay.date_utc}`,
        successCallback: () => {
          if (disposed) { try { sky.removeImageLayer(name) } catch { /* already removed */ } }
          else onSkyCaption(`Analysis · ${overlay.date_utc} · ${overlay.band}`)
        },
        errorCallback: () => { if (!disposed) setError('The aligned image could not load on the sky. The panel image and FITS download remain available.') },
      })
      sky.setOverlayImageLayer(added, name)
      sky.removeHiPSFromFavorites(added)
    }
    void run().catch(e => { if (!disposed) setError(String(e)) })
    return () => {
      disposed = true
      added?.setOpacity(0)
      try { sky.removeImageLayer(name) } catch { /* already removed */ }
      onSkyCaption(null)
    }
  }, [overlay, sky, onSkyCaption])

  useEffect(() => {
    if (!showFootprints || !sky || !search) return
    let disposed = false
    let layer: GraphicOverlay | null = null
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      layer = A.graphicOverlay({ name: `Analysis · ${band} exposure footprints`, color: getComputedStyle(document.documentElement).getPropertyValue('--overlay-footprint').trim(), lineWidth: 1 })
      sky.addOverlay(layer)
      for (const observation of search.observations.filter(o => o.band === band)) {
        const corners = parsePolygon(observation.s_region)
        if (corners) layer.add(A.polygon(corners))
      }
    }).catch(e => { if (!disposed) setError(String(e)) })
    return () => { disposed = true; if (layer) sky.removeOverlay(layer) }
  }, [sky, showFootprints, search, band])

  const groups = [
    { title: 'Observation search', checks: search?.checks ?? [] },
    { title: 'Aligned sequence', checks: result?.checks ?? [] },
    { title: 'Difference and residual vetting', checks: difference?.checks ?? [] },
    { title: 'Aperture spectrum', checks: spectrum.result?.checks ?? [] },
  ]

  return <div className={`reference-analysis${view === 'blink' || view === 'difference' ? ' standalone' : view === 'observations' || view === 'spectrum' ? ' chart-first' : ''}`} hidden={!view}>
    {view !== 'blink' && view !== 'difference' && <h3 className="h3">{view === 'spectrum' ? 'Aperture spectrum & visit comparison' : view === 'evidence' ? 'Additional analysis checks' : view === 'layers' ? 'Exposure footprints' : 'Wavelength coverage & other archives'}</h3>}
    {/* Name, detector and field centre are in the search bar and the player; only a Gaia position
        (moved with its proper motion) differs from them and is stated here. */}
    {target.pm_ra_mas_yr != null && target.pm_dec_mas_yr != null && <p className="small muted">
      Analysis position: Gaia DR3 at J{target.epoch_jyear} · RA {target.ra.toFixed(6)}° · Dec {target.dec.toFixed(6)}°, moved with its proper motion
    </p>}
    {searching && <p role="status">Searching IRSA observations…</p>}
    {error && <div className="alert alert--fail" role="alert">{error}<button className="btn" onClick={() => void load()}>Retry observation search</button></div>}
    {search && <>
      {search.checks.some(check => check.code === 'archive_error') && <div className="alert alert--warn" role="status">
        The archive search is incomplete. Missing results do not establish that this region has no coverage.
        <button className="btn" disabled={searching} onClick={() => void load()}>Retry archive search</button>
      </div>}
      {view === 'layers' && <>
        <label className="check"><input type="checkbox" checked={showFootprints} disabled={!sky}
          onChange={event => setShowFootprints(event.target.checked)} /> Show {band} exposure footprints on the sky</label>
        <p className="small muted">Real IRSA observation boundaries for the current target. Existing sky backgrounds, catalogues and image overlays remain in Sky layers above.</p>
      </>}
      {view === 'observations' && <><ObservationsPanel search={search} band={band} frames={frames ?? []} /><EvidencePanel groups={[groups[0]]} /></>}
      {(view === 'blink' || view === 'difference') && <>
        <details className="analysis-options" open={!result}>
        <summary>Sequence options · {mode === 'matched' ? 'Same wavelength' : mode === 'stack' ? 'Visit stacks' : 'All exposures'} · {fov}′</summary>
        <div className="analysis-setup">
          <label className="field"><span>Sequence algorithm</span><select value={mode} disabled={sequence.running} onChange={e => setMode(e.target.value as Mode)}>
            <option value="matched">Same wavelength · compare brightness</option>
            <option value="stack">Visit stacks · inspect motion</option>
            <option value="all">All exposures · wavelength varies</option>
          </select></label>
          <label className="field"><span>Analysis field (arcmin)</span><input type="number" min={2} max={30} step={1} value={fov} disabled={sequence.running} onChange={e => { setFov(Number(e.target.value)); setSearch(null) }} /></label>
          <button className="btn btn--primary" onClick={build} disabled={sequence.running || !Number.isFinite(fov) || fov < 2 || fov > 30 || search.observations.length === 0}>
            {sequence.running ? 'Building aligned sequence…' : result ? 'Rebuild aligned sequence' : 'Build aligned sequence'}
          </button>
        </div>
        <p className="small muted">{mode === 'matched' ? 'Selects a wavelength-matched exposure per visit, then aligns the images on one sky grid.' : mode === 'stack' ? 'Combines exposures per visit using inverse-variance weights. Broad wavelength ranges can change apparent brightness.' : 'Uses every exposure in time order. Different wavelengths can mimic variability.'} Field: {fov}′. Images download only when you build.</p>
        </details>
        {result && <p className="small muted">{result.frames.length} aligned frames · {result.band} · {result.grid.fov_arcmin}′ field · {result.mode}</p>}
        {sequence.running && sequence.job && <Progress value={sequence.job.progress} message={sequence.job.message} />}
        {sequence.error && <p className="alert alert--fail" role="alert">{sequence.error}</p>}
        {result && !frames?.length && <p className="alert alert--warn">No usable frames. Inspect Evidence or try another detector or sequence algorithm.</p>}
        {result && frames && frames.length > 0 && view === 'blink' && <BlinkPlayer key={sequence.job?.id} frames={frames} grid={result.grid} index={index} onIndex={setIndex} showOnSky={showOnSky} onShowOnSky={setShowOnSky} />}
        {view === 'difference' && result && frames && (frames.length >= 2
          ? <DifferencePanel key={sequence.job?.id} frames={frames} grid={result.grid} onResult={setDifference} initialResult={difference} />
          : <p className="muted">At least two usable frames are required for a difference.</p>)}
        <EvidencePanel groups={groups.filter(g => g.title !== 'Aperture spectrum')} />
      </>}
      {view === 'spectrum' && <><SpectrumPanel result={spectrum.result} running={spectrum.running}
        progress={spectrum.job?.progress ?? 0} message={spectrum.job?.message ?? ''} error={spectrum.error}
        visits={search.visits} nObservations={search.observations.length}
        onStart={n => void spectrum.start(() => api.startSpectrum(target, n))} /><EvidencePanel groups={[groups[3]]} /></>}
      {view === 'evidence' && <EvidencePanel groups={groups} />}
    </>}
    {/* Where the analysis compares visits (blink, difference, spectrum) it says so; Evidence has the menu's own note. */}
    {(view === 'blink' || view === 'difference' || view === 'spectrum') && <p className="small muted">Changes and residuals need verification. These calculations complement the main comparison; they use their own aligned sequence.</p>}
  </div>
}
