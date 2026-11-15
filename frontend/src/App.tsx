import { AnalysisReleaseInfo } from './analysis/AnalysisReleaseInfo'
import { AnalysisHost } from './analysis/AnalysisHost'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AladinInstance } from 'aladin-lite'
import { createFrames, getFrameJob, getObservations, getSurprise, resolveName } from './api'
import { AboutPanel } from './components/AboutPanel'
import { compatiblePair, stampText, type BlinkLetter, type BlinkPair } from './blink'
import { blockedReason, CANDIDATE_CAVEAT, type CheckActionId } from './checkGuide'
import { NO_MARKS, type LayerKey, type SkyMark } from './catalogLayers'
import type { ImageMark } from './components/ImageMarks'
import { BlinkPlayer } from './components/BlinkPlayer'
import { CandidatePanel } from './components/CandidatePanel'
import { TrackCheck } from './components/TrackCheck'
import { MARK_LETTERS, useCandidate, useMarkLayer } from './candidate'
import { DataLinks } from './components/DataLinks'
import { EvidencePanel, manifestChecks } from './components/EvidencePanel'
import { DataPanel } from './components/DataPanel'
import { DifferenceView } from './components/DifferenceView'
import { FloatingPanel } from './components/FloatingPanel'
import { HeaderTools } from './components/HeaderTools'
import { Inspector, type InspectorTab } from './components/Inspector'
import { LoadProgress } from './components/LoadProgress'
import { LayersSection } from './components/LayersSection'
import { ImagesToggle } from './components/ImagesToggle'
import { ObservationTimeline } from './components/ObservationTimeline'
import { SearchBar } from './components/SearchBar'
import { Skeleton } from './components/Skeleton'
import { SkyFrame } from './components/SkyFrame'
import { SkyView } from './components/SkyView'
import { SmallBodies, useSmallBodies } from './components/SmallBodies'
import { SourceList } from './components/SourceList'
import { PositionChart } from './components/PositionChart'
import { followPosition } from './positionTrack'
import { SourceMap } from './components/SourceMap'
import { SpectrumChart, useQuickSpectrum } from './components/SpectrumChart'
import { TargetForm } from './components/TargetForm'
import { useFrameLayers } from './frameLayers'
import { usePickLayer } from './pickLayer'
import { usePlateLayer } from './historicalPlate'
import { useMotionTrack } from './motionTrack'
import { useDistantTrack } from './distantTrack'
import { useFollowup } from './followup'
import { checkFrames, possibleTrack, searchCircles } from './track'
import { useTrackLayer } from './trackLayer'
import { sliceForDetector } from './sky'
import { sliceText, useCubeWavelengths, useSkySlice } from './skyCube'
import { epochFor, smallBodyMarkers, useSmallBodyLayer } from './smallBodyLayer'
import { changeLine, residualMarks, usePairDifference } from './pairDifference'
import { countSources, useSourceLayer } from './sourceLayer'
import { targetText } from './targets'
import type { DetectedSource, FrameJob, ObservationSummary, ProperMotion } from './types'
import { POLARIS, readEmbed, readMarks, readPair, readQuery, toSearch, type TargetQuery, type ViewMode } from './url'
import { downloadMarks } from './markExport'
import { PHONE, useMedia } from './useMedia'

const INITIAL = readQuery(window.location.search)
const EMBED = readEmbed(window.location.search)
// Candidate marks in a shared link belong to its comparison: they are placed once its frames are there (not embedded).
const LINKED_MARKS = INITIAL && !EMBED ? readMarks(window.location.search) : []
// A link's A and B (obs_ids), set once its comparison's final images are there.
const LINKED_PAIR = INITIAL ? readPair(window.location.search) : null
const POLARIS_CENTER = { ra: 37.954542, dec: 89.264111 }
const MAX_FRAMES = 12
const usesStacks = (mode: ViewMode) => mode !== 'exposures'
// No sidebar: the information about the comparison is one menu, the inspector under the overview map (one tab per
// kind, one bounded panel). The candidate check is the exception: it stands beside the image it marks on.
// Only controls open on demand, as a sheet: target & options, sky layers, about.
type Panel = 'target' | 'layers' | 'about'
type InspectId = 'quality' | 'measure' | 'coverage' | 'analysis' | 'data'
const PANELS: { id: Panel; title: string; label: string }[] = [
  { id: 'target', title: 'Target & options', label: 'Options' },
  { id: 'layers', title: 'Sky layers', label: 'Layers' },
  { id: 'about', title: 'About & credits', label: 'About' },
]

export default function App() {
  const [query, setQuery] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [draft, setDraft] = useState<TargetQuery>(INITIAL ?? POLARIS)
  const [center, setCenter] = useState(POLARIS_CENTER)
  // The query the map was last moved to; a failed request leaves the map where it was.
  const [centred, setCentred] = useState<Pick<TargetQuery, 'ra' | 'dec'>>(POLARIS)
  const [summary, setSummary] = useState<ObservationSummary | null>(null)
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [job, setJob] = useState<FrameJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [motion, setMotion] = useState<ProperMotion | null>(null)
  const [busy, setBusy] = useState(false)
  // The user stopped waiting for the first images (the worker may still finish them; Retry picks them up).
  const [stopped, setStopped] = useState(false)
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
  // The player's A/B pair, and requests to change it (Set A / Set B, "Choose a compatible pair").
  const [pair, setPair] = useState<BlinkPair | null>(null)
  const [pairRequest, setPairRequest] = useState<{ pair: Partial<BlinkPair> } | null>(null)
  // The source map runs UMAP in the browser: only while its section is open.
  const [sourceMapOpen, setSourceMapOpen] = useState(false)
  // The difference of A and B instead of the blink, for this job; back in the blink, the player starts on that pair.
  const [pairView, setPairView] = useState<{ job: string; open: boolean; pair: BlinkPair | null } | null>(null)
  const [analysisSkyCaption, setAnalysisSkyCaption] = useState<string | null>(null)
  const [framesOnSky, setFramesOnSky] = useState(true)
  const [sourcesOnSky, setSourcesOnSky] = useState(true)
  const [smallBodiesOnSky, setSmallBodiesOnSky] = useState(true)
  const [plateOnSky, setPlateOnSky] = useState(false)
  // The catalogue markers that are on in Layers, reported by CatalogLegend, for the SPHEREx images as well.
  const [catalogMarks, setCatalogMarks] = useState<Record<LayerKey, SkyMark[]>>(NO_MARKS)
  const [skySlice, setSkySlice] = useState(() => sliceForDetector((INITIAL ?? POLARIS).band))
  const [sliceBand, setSliceBand] = useState((INITIAL ?? POLARIS).band)
  const [viewRevision, setViewRevision] = useState(0)
  // Sheets open only on demand; the sky (Explore) and the page (Investigate) start uncovered.
  const [panel, setPanel] = useState<Panel | null>(null)
  // Explore: the full sky to choose a region. Investigate: the SPHEREx images of that region.
  const [stage, setStage] = useState<'explore' | 'investigate'>(INITIAL ? 'investigate' : 'explore')
  const [pick, setPick] = useState<{ ra: number; dec: number } | null>(null)
  const [name, setName] = useState('')
  const [shareStatus, setShareStatus] = useState('')
  // The inspector's tab; Expand lays it wider over the images (desktop); on phones it opens under the images.
  const [inspect, setInspect] = useState<InspectId>('quality')
  const [inspectOpen, setInspectOpen] = useState(false)
  const [inspectWide, setInspectWide] = useState(false)
  const inspectToggle = useRef<HTMLButtonElement>(null)
  const phone = useMedia(PHONE)
  // The analysis service's archive search starts once its results are asked for: the Analysis tab, or one of its
  // folded parts (Measure, Coverage) opened, or the sky layers.
  const [analysisWanted, setAnalysisWanted] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const lastRequest = useRef<{ query: TargetQuery; name?: string }>({ query: INITIAL ?? POLARIS })
  // The search text that stands for the comparison on screen; null once the field is edited or a new run starts.
  const searchShows = useRef<string | null>(null)
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const panelTrigger = useRef<HTMLButtonElement | null>(null)
  // The places the analysis parts render into.
  const [coverageSlot, setCoverageSlot] = useState<HTMLDivElement | null>(null)
  const [alignedSlot, setAlignedSlot] = useState<HTMLDivElement | null>(null)
  const [spectrumSlot, setSpectrumSlot] = useState<HTMLDivElement | null>(null)
  // A source picked in the list: the Measure tab follows it instead of the target, in this comparison only.
  const [followed, setFollowed] = useState<{ ra: number; dec: number; job: string } | null>(null)
  const [footprintsSlot, setFootprintsSlot] = useState<HTMLDivElement | null>(null)
  // Tabs opened for this comparison (and the one on screen): slow or external lookups wait for their tab.
  const [opened, setOpened] = useState<ReadonlySet<InspectId>>(() => new Set())
  const selectInspect = useCallback((id: InspectId) => {
    setInspect(id)
    setOpened((previous) => (previous.has(id) ? previous : new Set([...previous, id])))
  }, [])

  const closePanel = useCallback(() => {
    if (!panel) return
    setPanel(null)
    const trigger = panelTrigger.current
    // A trigger in the hidden viewer (Explore) cannot take the focus back; the sky map can.
    if (trigger && trigger.offsetParent !== null) trigger.focus()
    else document.getElementById('sky-map')?.focus()
  }, [panel])

  // Phones: the inspector under the images closes; the focus it held goes back to Inspect.
  const closeInspect = useCallback(() => {
    setInspectOpen(false)
    if (document.activeElement?.closest('.inspector')) inspectToggle.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' &&
          !event.defaultPrevented && !(event.target instanceof HTMLSelectElement)) {
        if (panel) closePanel()
        else if (inspectWide && !phone) setInspectWide(false)
        else if (inspectOpen && phone) closeInspect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePanel, panel, inspectWide, inspectOpen, phone, closeInspect])

  // The inspector hangs under the overview map card: the card's height as a CSS variable on the shell
  // (styles/shell.css). An expanded map has no card box (0 × 0): the last height stays for when it docks again.
  useLayoutEffect(() => {
    const shell = shellRef.current
    const card = shell?.querySelector<HTMLElement>('.sky-area')
    if (!shell || !card) return
    const hud = shell.querySelector<HTMLElement>('.hud')
    const observer = new ResizeObserver(() => {
      // The search bar's height: on the full map, Aladin's top controls sit below it.
      if (hud) shell.style.setProperty('--hud-h', `${hud.offsetHeight}px`)
      if (!card.offsetWidth) return
      shell.style.setProperty('--map-card-h', `${card.offsetHeight}px`)
    })
    observer.observe(card)
    if (hud) observer.observe(hud)
    return () => observer.disconnect()
  }, [])

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
    setStopped(false)
    searchShows.current = null
    setBusy(true)
    setError(null)
    setJob(null)
    setSummary(null)
    setSummaryFailed(false)
    setMotion(null)
    setPlateOnSky(false)
    setFrameIndex(0)
    setStage('investigate')
    setPick(null)
    // A new comparison starts with its own lookups: only the tab on screen counts as opened.
    setOpened(new Set())
    setAnalysisWanted(false)
    // The images show the result; the target panel would cover them on small screens.
    setPanel((open) => (open === 'target' ? null : open))
    setName(targetName ?? targetText(requested))
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
      searchShows.current = targetText(next)
      setDraft(next)
      setMotion(nextMotion)
      window.history.replaceState(null, '', toSearch(next, EMBED))
      // A name in a shared link only adds the Gaia proper motion; the frames follow the coordinates.
      if (!targetName && next.name && !knownMotion) {
        resolveName(next.name, signal).then((target) => {
          if (!stale()) setMotion(target.proper_motion ?? null)
        }, () => undefined)
      }
      setStatus('Searching SPHEREx observations…')
      // Coverage metadata must not hold up the first ready images.
      getObservations(next.ra, next.dec, signal).then((found) => {
        if (!stale()) {
          setSummary(found)
          setCenter({ ra: found.ra, dec: found.dec })
          setCentred(next)
          setViewRevision((value) => value + 1)
        }
      }, () => { if (!stale()) setSummaryFailed(true) })
      if (Number.isFinite(Number(next.ra)) && Number.isFinite(Number(next.dec))) {
        setCenter({ ra: Number(next.ra), dec: Number(next.dec) })
      }
      setCentred(next)
      setViewRevision((value) => value + 1)
      let state = await createFrames({ ra: next.ra, dec: next.dec, size_deg: next.fov,
        detector: next.band, max_frames: MAX_FRAMES, stack: usesStacks(next.mode) }, signal)
      if (stale()) return
      setJob(state)
      if (state.manifest) setCenter({ ra: state.manifest.ra, dec: state.manifest.dec })
      const deadline = Date.now() + 10 * 60_000
      while (state.status === 'queued' || state.status === 'started') {
        if (Date.now() > deadline) throw new Error('The archive is taking too long. Retry or choose another region.')
        setStatus(state.manifest?.preview
          ? `Preview · ${state.manifest.frames.length} images ready · ${state.progress < state.total ? `loading ${state.progress} of ${state.total}` : 'preparing final images and checks'}`
          : state.status === 'started' && state.total > 0
          ? `Preparing cutouts · ${state.progress} of ${state.total}` : 'Waiting for SPHEREx cutouts…')
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        if (stale()) return
        state = await getFrameJob(state.job_id, signal)
        if (stale()) return
        if (state.manifest) setCenter({ ra: state.manifest.ra, dec: state.manifest.dec })
        const incoming = state
        setJob((previous) => {
          const same = previous?.manifest?.preview && incoming.manifest?.preview &&
            previous.manifest.frames.map((f) => f.url).join() === incoming.manifest.frames.map((f) => f.url).join()
          return same ? { ...incoming, manifest: previous.manifest } : incoming
        })
      }
      if (state.status === 'failed') throw new Error(state.error ?? 'Preparing the images failed. Please try again.')
      if (state.status === 'not_found') throw new Error('This comparison expired. Retry to prepare it again.')
      setStatus(state.manifest?.frames.length
        ? `${state.manifest.frames.length} images ready · ${state.manifest.epochs} epochs`
        : 'No usable images for this region and detector.')
    } catch (cause) {
      if (!stale()) {
        // The message, never a Python class name in front of it ("app.archive.ArchiveError: …").
        const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/^[A-Za-z_][\w.]*(?:Error|Exception): /, '')
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
  // An unedited search field stands for the comparison on screen, also when it shows a label or coordinates:
  // compare that position again (e.g. with the detector chosen next to it) instead of resolving the text as a name.
  const find = useCallback((target: string, base: TargetQuery) => {
    if (target === searchShows.current) show({ ...base, ra: query.ra, dec: query.dec })
    else void run(base, target)
  }, [run, query, show])
  // Surprise me: the API picks a random fast-moving Gaia DR3 star (an example target while Gaia is down). Why it was
  // picked stays on screen while that position is shown, so it goes away when the user moves on.
  const [surprise, setSurprise] = useState<{ ra: string, dec: string, reason: string } | null>(null)
  const surpriseMe = useCallback(async () => {
    controller.current?.abort()
    const picking = new AbortController()
    controller.current = picking
    setBusy(true)
    setStopped(false)
    setError(null)
    setJob(null)
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
  // Why Difference cannot be chosen, in the words of the check that blocks it, with its action when it has one.
  const differenceReason = manifest ? blockedReason(checks, 'difference')
    ?? (manifest.epochs < 2 ? { text: 'Difference needs observations from at least two epochs.' } : null) : null
  const differenceBlocked = differenceReason?.text
  const showDifference = (query.mode === 'difference' || (!!pairView?.open && pairView.job === job?.job_id))
    && !!manifest && !manifest.preview && manifest.frames.length > 1
  const hasFrames = (manifest?.frames.length ?? 0) > 0
  // The player's frame blinks on the sky; the difference image stays in the panel.
  const frameLayers = useFrameLayers(sky, manifest, frameIndex, framesOnSky && !showDifference && !analysisSkyCaption)
  useSourceLayer(sky, manifest?.frames, frameIndex, sourcesOnSky && hasFrames && !showDifference && !analysisSkyCaption)
  const track = useMotionTrack(sky, motion, manifest?.frames)
  // The plate follows the field only once the map is centred on the current target.
  const plate = usePlateLayer(sky, plateOnSky, centred.ra === query.ra && centred.dec === query.dec ? center : null, motion)
  const frame = (hasFrames && manifest?.frames[frameIndex]) || null
  const followedHere = followed && followed.job === job?.job_id ? followed : null
  // Position over time from the detections of every frame: the target (along its Gaia motion when known) or the
  // source picked in the list.
  const positionTrack = useMemo(() => manifest && hasFrames
    ? followPosition(manifest.frames, followedHere ?? { ra: manifest.ra, dec: manifest.dec }, manifest.pixel_scale_arcsec,
      followedHere ? null : motion)
    : null, [manifest, hasFrames, followedHere, motion])
  const counts = frame?.sources ? countSources(frame.sources) : null
  const sourceSummary = counts ? ` · ${counts.detected} in this frame · ${counts.none} ${counts.none === 1 ? 'needs' : 'need'} verification${counts.unknown ? ` · ${counts.unknown} unknown` : ''}` : ''
  const frameOnSky = frame && sky && framesOnSky && !showDifference && !analysisSkyCaption ? frame : null
  const markBlocked = showDifference ? 'Marks are set on single frames, not on the difference image.'
    : manifest?.preview ? 'Mark candidates after the final images and checks are ready.' : null
  // Marking by clicking works on the image, and on the sky wherever the SPHEREx frame is on it: the overview map
  // and, larger, the full sky (Explore).
  const skyMarking = !markBlocked && !!frameOnSky
  // A link's marks are placed only in the link's own comparison (stacks and difference share one).
  const linkComparison = !!INITIAL && query.ra === INITIAL.ra && query.dec === INITIAL.dec && query.fov === INITIAL.fov
    && query.band === INITIAL.band && usesStacks(query.mode) === usesStacks(INITIAL.mode)
  const candidate = useCandidate(job?.job_id ?? null, !markBlocked, manifest && !manifest.preview && linkComparison ? manifest : null, LINKED_MARKS)
  // The address bar carries the marks (the link's, until they are placed) and A and B: a reload or a copied address
  // keeps them.
  const urlMarks = candidate.shareMarks.length > 0 ? candidate.shareMarks : candidate.linked
  const pairIds = useMemo(() => (manifest && !manifest.preview && pair && manifest.frames[pair.a] && manifest.frames[pair.b]
    ? { a: manifest.frames[pair.a].obs_id, b: manifest.frames[pair.b].obs_id } : null), [manifest, pair])
  // The link's A and B in its own comparison's final images: the player starts on them.
  const linkedPair = useMemo(() => {
    if (!LINKED_PAIR || !linkComparison || !manifest || manifest.preview) return null
    const a = manifest.frames.findIndex((f) => f.obs_id === LINKED_PAIR.a)
    const b = manifest.frames.findIndex((f) => f.obs_id === LINKED_PAIR.b)
    return a >= 0 && b >= 0 && a !== b ? { a, b } : null
  }, [manifest, linkComparison])
  useEffect(() => {
    // While the link's comparison loads, its A and B stay in the address.
    if (!EMBED) window.history.replaceState(null, '', toSearch(query, EMBED, urlMarks, pairIds ?? (linkComparison ? LINKED_PAIR : null)))
  }, [query, urlMarks, pairIds, linkComparison])
  useMarkLayer(sky, candidate.allMarks)
  // The link opens this comparison with the marks set in it.
  const link = () => new URL(toSearch(query, EMBED, candidate.shareMarks, pairIds), window.location.href).href
  const share = async () => {
    try {
      await navigator.clipboard.writeText(link())
      const letters = candidate.marks.map((_, i) => MARK_LETTERS[i]).join(' and ')
      setShareStatus(letters ? `Comparison link copied with marks ${letters}` : 'Comparison link copied')
    } catch {
      setShareStatus('Copy unavailable. Copy the address from your browser.')
    }
  }
  const possible = useMemo(() => manifest ? possibleTrack(candidate.marks, manifest, manifest.frames.map((f) => f.mjd)) : null, [candidate.marks, manifest])
  // Drawn and checked with the same search radius: 2σ, at least 1.5 pixels.
  const predictions = useMemo(() => (showDifference || !manifest ? [] : searchCircles(possible?.predictions ?? [], manifest.pixel_scale_arcsec)),
    [possible, showDifference, manifest])
  useTrackLayer(sky, predictions)
  const distant = useDistantTrack(showDifference ? null : sky, possible, candidate.marks, manifest)
  const followup = useFollowup(possible, candidate.marks, manifest)
  usePickLayer(sky, stage === 'explore' ? pick : null, draft.fov)
  // JPL SBIdent takes about a minute per time: one time per epoch, its first frame's.
  // A stack mixes exposures from up to 30 days: moving asteroids are looked up for single exposures.
  const smallBodies = useSmallBodies(manifest && hasFrames && !manifest.stacked && !manifest.preview ? {
    ra: `${manifest.ra}`, dec: `${manifest.dec}`, size_deg: manifest.size_deg,
    mjds: manifest.frames.filter((f, i, all) => all.findIndex((g) => g.epoch === f.epoch) === i).map((f) => f.mjd).slice(0, 6),
  } : null)
  useSmallBodyLayer(sky, smallBodies.epochs, frame?.mjd ?? null, smallBodiesOnSky)
  // The worker finds the changes of every A/B pair the blink shows (final images only); a finished small-body lookup
  // explains them again.
  const pairChanges = usePairDifference(job, pair ?? linkedPair, smallBodies.job)
  // Everything the layers show on the sky for the shown frame, on its SPHEREx image too.
  const imageMarks = useMemo<ImageMark[]>(() => {
    if (!frame || showDifference) return []
    const marks: ImageMark[] = (['gaia', 'wise', 'simbad', 'skybot'] as LayerKey[])
      .flatMap((key) => catalogMarks[key].map((mark) => ({ ...mark, kind: key })))
    const epoch = smallBodiesOnSky ? epochFor(smallBodies.epochs, frame.mjd) : null
    if (epoch) marks.push(...smallBodyMarkers(epoch, frame.mjd).map((body) => ({ ra: body.ra, dec: body.dec, name: body.data.label, kind: 'sbident' as const })))
    if (sourcesOnSky && frame.sources) {
      marks.push(...frame.sources.map((source) => ({ ra: source.ra, dec: source.dec,
        kind: source.match === 'none' ? 'source-none' as const : source.match === 'unknown' ? 'source-unknown' as const : 'source-match' as const,
        name: `Detected · S/N ${source.snr.toFixed(0)} · ${source.match === 'none' ? 'no catalogue match, needs verification'
          : source.match === 'unknown' ? 'catalogue unavailable' : `${source.catalog_id ?? source.match}`}` })))
    }
    marks.push(...residualMarks(pairChanges.result, job?.job_id, pair, frameIndex))
    return marks
  }, [frame, showDifference, catalogMarks, smallBodiesOnSky, smallBodies.epochs, sourcesOnSky, pairChanges.result, job?.job_id, pair, frameIndex])

  // The actions the checks offer (EvidencePanel, the Difference reason): each does what its label says.
  const onCheckAction = (action: CheckActionId) => {
    if (action === 'retry') return void run(lastRequest.current.query, lastRequest.current.name)
    if (action === 'choose-region') {
      setStage('explore')
      setPanel('target')
      window.setTimeout(() => panelHeading.current?.focus(), 0)
      return
    }
    const next = manifest && compatiblePair(manifest.frames)
    if (!next) return setShareStatus('No two images of this comparison share a wavelength across epochs. Choose another region or detector.')
    const same = pair?.a === next.a && pair?.b === next.b
    setPairRequest({ pair: next })
    setShareStatus(same ? 'A and B already share a wavelength: blinking them.' : 'A and B now share a wavelength: blinking them.')
  }
  // The quick-look spectrum measures the target, or a source the user picked ("Spectrum" in the source list).
  const [spectrumSource, setSpectrumSource] = useState<{ job: string; ra: number; dec: number; label: string } | null>(null)
  const pickedSource = spectrumSource && spectrumSource.job === job?.job_id ? spectrumSource : null
  const quick = useQuickSpectrum(manifest ? `${pickedSource?.ra ?? manifest.ra}` : null, manifest ? `${pickedSource?.dec ?? manifest.dec}` : null)
  const startQuick = quick.start
  // A picked source starts its measurement once the hook has its position, and shows it in Measure.
  const pendingSpectrum = useRef(false)
  useEffect(() => {
    if (!pendingSpectrum.current || !pickedSource) return
    pendingSpectrum.current = false
    startQuick()
  }, [pickedSource, startQuick])
  const spectrumOf = (source: DetectedSource) => {
    if (!job) return
    selectInspect('measure')
    if (pickedSource && pickedSource.ra === source.ra && pickedSource.dec === source.dec) return
    pendingSpectrum.current = true
    setSpectrumSource({ job: job.job_id, ra: source.ra, dec: source.dec, label: source.catalog_id ?? `source at RA ${source.ra.toFixed(5)}° Dec ${source.dec.toFixed(5)}°` })
  }
  const tabsSeen = new Set<InspectId>([...opened, ...(stage === 'investigate' && (!phone || inspectOpen) ? [inspect] : [])])

  // Stop waiting for a slow archive: the requests stop here; the server's job is not cancelled, so Retry may find it done.
  const stopWaiting = () => {
    controller.current?.abort()
    setBusy(false)
    setStopped(true)
    setStatus(job ? 'Stopped waiting. The server keeps preparing these images: Retry picks them up.' : 'Stopped waiting.')
  }
  const statusBlock = (
    <>
      {/* Shown as the loading bar on the viewer head; the words are for screen readers. */}
      <p className="comparison-status sr-only" role="status" aria-live="polite">{status}</p>
      {error && <div className="notice error" role="alert"><strong>Comparison unavailable</strong><p>{error}</p>
        {/IRSA/.test(error) && !EMBED && <p>This position needs an archive response. Previously saved comparisons can still open; an example is available offline only after its images have been stored.</p>}
        {!EMBED && (centred.ra !== query.ra || centred.dec !== query.dec) && <p>The map still shows the previous position.</p>}</div>}
      {stopped && !busy && !hasFrames && !error && <p className="notice">{job
        ? 'Stopped waiting. The server keeps preparing these images: Retry picks them up.' : 'Stopped waiting.'}</p>}
      {(!busy && (error || stopped || (!hasFrames && job))) && (
        <div className="recovery-actions">
          <button type="button" onClick={() => void run(lastRequest.current.query, lastRequest.current.name)}>Retry</button>
          {!EMBED && <button type="button" onClick={() => { setStage('explore'); setPanel('target') }}>Choose another region</button>}
        </div>
      )}
    </>
  )
  // While the first images are prepared: grey frames where the thumbnails, image, bar and A/B table will be (same grid).
  const loadingViewer = busy && !hasFrames && !error && (
    <div className="player player-skeleton">
      <div className="observation-gallery" aria-hidden="true"><div className="observation-strip">
        {[0, 1, 2, 3].map((i) => <div key={i} className="observation-card"><Skeleton variant="thumb" /></div>)}
      </div></div>
      <div className="viewport" aria-hidden="true"><Skeleton variant="image" /></div>
      {/* Where Play will stand: the one action while the archive is slow. The bar above shows the progress. */}
      <div className="controls transport"><button type="button" onClick={stopWaiting}>Stop waiting</button></div>
      <div className="player-side" aria-hidden="true"><Skeleton variant="line" lines={4} /><Skeleton variant="line" lines={8} /></div>
    </div>
  )
  const emptyState = !busy && !hasFrames && !error && !stopped && (EMBED && !job
    ? <p className="muted">Add ra and dec to the URL, e.g. ?ra=02:31:49.09&amp;dec=+89:15:50.8&amp;embed=1</p>
    : <div className="empty-state">
      <span className="empty-reticle" aria-hidden="true" />
      <h3>{job ? 'No images to compare' : 'One region. Different moments.'}</h3>
      <p>{job ? 'Try another detector or sky region. Repeat coverage varies by position.' : 'Choose a target or use the map center to load real SPHEREx observations.'}</p>
      {!EMBED && <button type="button" onClick={useMapCenter} disabled={skyUnavailable || !sky}>Compare map center</button>}
    </div>)
  // Only an action that lifts the block stands beside the reason: a compatible blink pair does not make the server's
  // difference comparable, and an embed has no region to choose.
  const liftAction = differenceReason?.action && differenceReason.action.id !== 'choose-compatible-pair'
    && !(EMBED && differenceReason.action.id === 'choose-region') ? differenceReason.action : undefined
  // Which images A and B are; the difference image is a view of the comparison, offered only when it can be made.
  const imagesToggle = <ImagesToggle value={query.mode === 'exposures' ? 'exposures' : 'stacks'} onChange={selectMode} disabled={busy && !job} />
  const changeText = changeLine(pairChanges)
  const changes = manifest && hasFrames && (
    <details className="changes" aria-label="Difference image">
      <summary>Difference image</summary>
      {changeText
        ? <p>{changeText}{pairChanges.result?.comparable && job && <> · <button type="button" className="text-button" onClick={() => setPairView({ job: job.job_id, open: true, pair })}>Show the difference</button></>}</p>
        : differenceBlocked && <p className="muted">{differenceBlocked}{liftAction && <> <button type="button" className="text-button" onClick={() => onCheckAction(liftAction.id)}>{liftAction.label}</button></>}</p>}
    </details>
  )
  // Beside the image, under the A/B table (under the difference image, which has its own side column): the user
  // marks in the image and reads the check next to it.
  const candidateSide = manifest && hasFrames && <div className="candidate-side">
    <CandidatePanel candidate={candidate} blocked={markBlocked} track={possible && { ...possible, predictions }} distant={distant} sources={!skyUnavailable}
      followup={followup}
      onDownload={() => downloadMarks({ link: link(), target: targetText(query), manifest, marks: candidate.marks, track: possible,
        verdict: candidate.verdict, verdictChosen: candidate.verdictChosen, exported: new Date(), base: window.location.href })}
      known={{ epochs: smallBodies.epochs, motion, detector: manifest.detector, target: targetText(query) }}
      visits={summary && { observations: summary.observations, inBlink: [...manifest.frames.map((f) => f.obs_id),
        ...manifest.differences.flatMap((d) => [...d.obs_ids_a, ...d.obs_ids_b])] }}>
      {possible && predictions.length > 0 && <TrackCheck checks={checkFrames({ ...possible, predictions }, manifest.frames, candidate.marks, manifest)}
        onShow={(index, p) => { setSeek({ index }); sky?.gotoRaDec(p.ra, p.dec) }} />}
    </CandidatePanel>
    {!skyUnavailable && frame && !showDifference && <details className="disclosure">
      <summary>Detected sources{sourceSummary}</summary>
      <SourceList frame={frame} onSelect={(ra, dec) => { sky?.gotoRaDec(ra, dec); if (job) setFollowed({ ra, dec, job: job.job_id }) }} onMark={(source) => candidate.markSource(frame, source)}
        onSpectrum={spectrumOf} />
    </details>}
    {!skyUnavailable && !showDifference && manifest.frames.length >= 2 && <details className="disclosure" onToggle={(event) => setSourceMapOpen(event.currentTarget.open)}>
      <summary>Source map · unusual sources first</summary>
      {sourceMapOpen && <SourceMap frames={manifest.frames} pixelScaleArcsec={manifest.pixel_scale_arcsec} marks={candidate.marks}
        onSelect={(ra, dec) => sky?.gotoRaDec(ra, dec)} />}
    </details>}
    {manifest.stacked
      ? <p className="muted">Known asteroids and comets (JPL SBIdent) are looked up for single exposures: switch the view to Exposures.</p>
      : <SmallBodies lookup={smallBodies} currentMjd={frame?.mjd ?? null} />}
  </div>
  const viewer = manifest && hasFrames && (showDifference
    ? <>
      <div className="view-back">
        <button type="button" className="text-button" onClick={() => (query.mode === 'difference' ? selectMode('stacks')
          : setPairView({ job: job.job_id, open: false, pair }))}><span aria-hidden="true">←</span> Back to the blink</button>
        <span className="muted">The blink&apos;s A and B</span>
      </div>
      <DifferenceView key={job.job_id} manifest={manifest} changes={pairChanges} />
      {!EMBED && candidateSide}
    </>
    : <BlinkPlayer key={`${job.job_id}-${manifest.preview ? manifest.frames[0]?.url : 'final'}`} frames={manifest.frames} checks={checks} grid={manifest} motion={motion} predictions={predictions}
      onIndexChange={showFrame} onPairChange={setPair} seek={seek} pairRequest={pairRequest} initialPair={pairView?.job === job.job_id ? pairView.pair : linkedPair} active={EMBED || stage === 'investigate'} showShare={EMBED}
      controls={imagesToggle} changes={changes} marks={imageMarks} candidate={!EMBED && candidateSide}
      marking={candidate.armed} candidateMarks={candidate.allMarks} onMark={(shown, ra, dec) => candidate.markAt(shown, manifest, ra, dec)} />)
  const evidence = manifest && <EvidencePanel checks={checks} manifest={manifest} frameLabel={`this comparison · ${manifest.frames.length} ${manifest.frames.length === 1 ? 'image' : 'images'}`}
    onAction={(action) => { if (!EMBED || action !== 'choose-region') onCheckAction(action) }} />

  const analysisTarget = useMemo(() => summary ? {
    ra: motion?.ra ?? summary.ra, dec: motion?.dec ?? summary.dec, name: query.name ?? null,
    epoch_jyear: motion?.ref_epoch ?? 2000,
    pm_ra_mas_yr: motion?.pmra_mas_yr ?? null, pm_dec_mas_yr: motion?.pmdec_mas_yr ?? null,
    source: 'Current comparison target',
  } : null, [summary, query.name, motion])

  if (EMBED) return <main className="embed-workspace"><LoadProgress busy={busy} job={job} />{statusBlock}{emptyState}{viewer}
    {hasFrames && <p className="caveat"><strong>{CANDIDATE_CAVEAT.title}.</strong> {CANDIDATE_CAVEAT.text}</p>}
    {evidence && <details className="disclosure" open={!!differenceBlocked}><summary>Quality checks · {checks.length}</summary>{evidence}</details>}
    <p className="muted">SPHEREx · {manifest?.collection ?? summary?.collection ?? 'IRSA archive'}</p></main>

  const loadFirst = <p className="muted">Load a comparison first: choose a target in the search bar.</p>
  // A tab whose content is on its way: grey frames instead of "load first" while the comparison loads.
  const pending = (shape: 'chart' | 'lines', words: string) => busy ? <div className="tab-loading" aria-busy="true">
    <p className="sr-only">{words}</p>
    {shape === 'chart' && <Skeleton variant="chart" />}
    <Skeleton variant="line" lines={shape === 'chart' ? 2 : 6} />
  </div> : loadFirst
  const blocking = checks.some((check) => check.severity === 'blocker' || check.severity === 'error')
  const current = PANELS.find((item) => item.id === panel)
  // One tab per question a scientist asks, in the order of the investigation: can I trust the comparison, how does
  // it measure, where else was it observed, a second method, the data. What A and B are, and whether it is a
  // candidate, stand beside the image. Results first; second methods and provenance details stay folded. Every panel stays mounted.
  const tabs: InspectorTab<InspectId>[] = [
    { id: 'quality', label: 'Image checks', count: undefined, alert: blocking, content: evidence || pending('lines', 'Loading the checks…') },
    { id: 'measure', label: 'Measure', content: <>
      {manifest && positionTrack && <PositionChart track={positionTrack} subject={followedHere ? 'the selected source' : 'the target'}
        detector={manifest.detector} onFollowTarget={followedHere ? () => setFollowed(null) : undefined} />}
      {manifest ? <SpectrumChart quick={quick} centerUm={(frame ?? manifest.frames[0])?.wavelength_um} detector={manifest.detector}
        subject={pickedSource?.label} onBackToTarget={pickedSource ? () => setSpectrumSource(null) : undefined} />
        : pending('chart', 'Loading the comparison…')}
      {analysisTarget && <details className="disclosure" onToggle={(event) => { if (event.currentTarget.open) setAnalysisWanted(true) }}>
        <summary>Second method: aligned aperture spectrum</summary>
        <div ref={setSpectrumSlot} />
      </details>}
    </> },
    { id: 'coverage', label: 'Coverage', count: summary?.count, content: <>
      {summary ? <>
        <div className="history-summary">
          <span><strong>{summary.epochs.length}</strong> epochs</span>
          <span><strong>{summary.detectors[String(manifest?.detector ?? query.band)] ?? 0}</strong> in D{manifest?.detector ?? query.band}</span>
        </div>
        <ObservationTimeline observations={summary.observations} frames={manifest?.frames}
          currentIndex={showDifference ? undefined : frameIndex} detector={manifest?.detector ?? query.band} />
      </> : summaryFailed || (error && !busy) ? <p className="muted">The observation history could not be loaded for this position.</p>
        : job && !busy ? <div className="tab-loading" aria-busy="true"><p className="sr-only">Loading the observation history…</p>
          <Skeleton variant="chart" /><Skeleton variant="line" lines={2} /></div>
        : pending('chart', 'Loading the observation history…')}
      {analysisTarget && <details className="disclosure" onToggle={(event) => { if (event.currentTarget.open) setAnalysisWanted(true) }}>
        <summary>Wavelength coverage & other archives</summary>
        <div ref={setCoverageSlot} />
      </details>}
    </> },
    { id: 'analysis', label: 'Analysis', content: <>
      <p className="muted">Blink and difference on one sky grid, from their own aligned sequence.</p>
      {analysisTarget ? <div ref={setAlignedSlot} />
        : summaryFailed || (error && !busy) ? <p className="muted">The aligned analysis needs the observation history, which could not be loaded for this position.</p>
        : job && !busy ? <div className="tab-loading" aria-busy="true"><p className="sr-only">Loading the observation history…</p><Skeleton variant="line" lines={3} /></div>
        : pending('lines', 'Loading the comparison…')}
    </> },
    { id: 'data', label: 'Data', content: <>
      {manifest && hasFrames && <DataLinks manifest={manifest} frame={showDifference ? null : frame} />}
      <DataPanel query={query} summary={summary} manifest={manifest}
        open={stage === 'investigate' && tabsSeen.has('data')} onAbout={() => {
          // The button that opened About takes the focus back when it closes.
          panelTrigger.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
          setPanel('about')
        }} />
    </> },
  ]

  return (
    <div className="shell" data-testid="planet-x-shell" ref={shellRef}>
      <a className="skip-link" href="#sky-map">Skip to the sky map</a>
      <SearchBar tools={<HeaderTools items={PANELS} open={panel} onToggle={togglePanel}
        actions={[{ id: 'share', label: 'Share', title: 'Copy this comparison link', onClick: () => void share() }]} />} onDraftChange={setDraft} value={name} onChange={(value) => { searchShows.current = null; setName(value) }} draft={draft} busy={busy} onShow={show} onFind={find} onSurprise={() => void surpriseMe()} />

      <div className={`stage ${stage}`}>
        <section className="viewer" aria-label="SPHEREx images of the region" hidden={stage !== 'investigate'}>
          <div className="viewer-head">
            <LoadProgress busy={busy} job={job} />
            {/* Phones: the inspector is a bottom sheet opened from here. */}
            <button ref={inspectToggle} type="button" className="inspect-toggle" aria-expanded={inspectOpen} aria-controls="inspector"
              onClick={() => (inspectOpen ? closeInspect() : setInspectOpen(true))}>Inspect</button>
          </div>
          <div className="viewer-body">
            {statusBlock}
            {job && emptyState}
            {loadingViewer}
            {viewer}
          </div>
        </section>
        {/* Under the overview map and as wide as it (desktop), under the images when opened (phones): styles/shell.css.
            Kept mounted in Explore, so its charts, jobs and analysis parts keep their state. */}
        <Inspector id="inspector" tabs={tabs} active={inspect} onSelect={selectInspect} hidden={stage !== 'investigate'}
          open={inspectOpen} onClose={closeInspect} expanded={inspectWide} onExpand={setInspectWide} />
        <SkyFrame overview={stage === 'investigate'} onFullMap={() => setStage('explore')}>
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
            {analysisSkyCaption && <span className="frame-caption">{analysisSkyCaption}</span>}
            <span className="map-hint">Drag to explore · scroll to zoom · map tools at left</span>
          </footer>
        </SkyFrame>
        {stage === 'explore' && <div className="explore-actions">
          {/* One short cue on the first visit; the sky stays the page. */}
          {!pick && !job && !panel && <div className="pick-card explore-cue" role="note">
            <span>Search a target, pick an example, or click the sky to choose a region.</span>
            <button type="button" onClick={useMapCenter} disabled={skyUnavailable || !sky}>Compare map center</button>
          </div>}
          {pick && <div className="pick-card" role="group" aria-label="Selected position">
            <span>RA {pick.ra.toFixed(5)}° · Dec {pick.dec.toFixed(5)}°</span>
            <button type="button" className="primary" onClick={() => show({ ...draft, ra: pick.ra.toFixed(6), dec: pick.dec.toFixed(6) })}>Compare here</button>
            <button type="button" aria-label="Clear the selected position" onClick={() => setPick(null)}>✕</button>
          </div>}
          {/* Candidate marking on the full sky: the marks and the check stay beside the images. */}
          {job && skyMarking && (candidate.armed
            ? <div className="pick-card candidate-sky" role="group" aria-label="Candidate marking on the sky">
              <span><span aria-hidden="true">◎</span> Click the object inside the SPHEREx frame · {candidate.marks.length}/2 marks</span>
              <span className="candidate-notice" role="status" aria-live="polite">{candidate.notice}</span>
              <button type="button" onClick={() => candidate.setArmed(false)}>Done</button>
            </div>
            : <button type="button" onClick={() => candidate.setArmed(true)}><span aria-hidden="true">◎</span> Mark a candidate on the sky</button>)}
          {job && <button type="button" onClick={() => setStage('investigate')}>Back to images <span aria-hidden="true">→</span></button>}
        </div>}
      </div>



      {/* Controls on demand: a sheet, closed by default; the information stays in the inspector. */}
      <FloatingPanel hidden={!current} title={current?.title ?? ''} headingRef={panelHeading} onClose={closePanel}
        actions={panel === 'target' && <>
          <button type="submit" form="region-form" className="primary" disabled={busy}>Compare this position <span aria-hidden="true">→</span></button>
          <button type="button" onClick={useMapCenter} disabled={busy || skyUnavailable || !sky}>Use map center & compare</button>
        </>}>
        <section id="target-panel" hidden={panel !== 'target'}>
          <TargetForm value={draft} busy={busy} onShow={show} onFind={find} onChange={setDraft} />
        </section>
        <section id="layers-panel" hidden={panel !== 'layers'}>
          {skyUnavailable ? <p className="muted">Sky layers need WebGL2.</p> : <LayersSection aladin={sky} sizeDeg={query.fov} frame={frame}
            framesOnSky={framesOnSky} onFramesOnSkyChange={setFramesOnSky} sourcesOnSky={sourcesOnSky} onSourcesOnSkyChange={setSourcesOnSky}
            trackShown={track.length > 0} possibleTrackShown={predictions.length > 0} skySlice={skySlice} onSkySliceChange={setSkySlice} cubeActive={cubeActive}
            smallBodyEpochs={smallBodies.epochs} smallBodiesOnSky={smallBodiesOnSky} onSmallBodiesOnSkyChange={setSmallBodiesOnSky}
            plateAvailable={!!motion} plateOnSky={plateOnSky} onPlateOnSkyChange={setPlateOnSky} plate={plate}
            framesBlocked={showDifference ? 'The difference image is shown in the viewer. Frames and their detected sources go back on the sky in the other modes.' : undefined}
            onCatalogMarks={setCatalogMarks} />}
          {analysisTarget && <><h3>Exposure footprints</h3><div ref={setFootprintsSlot} /></>}
        </section>
        <section id="about-panel" hidden={panel !== 'about'}>
          <AboutPanel />
          <AnalysisReleaseInfo />
        </section>
      </FloatingPanel>
      {analysisTarget && <AnalysisHost key={`${analysisTarget.ra}:${analysisTarget.dec}:${query.band}:${query.fov}`}
        target={analysisTarget} detector={query.band} fovDegrees={query.fov} onPage={stage === 'investigate'}
        active={(stage === 'investigate' && (analysisWanted || tabsSeen.has('analysis'))) || panel === 'layers'}
        sky={sky} onSkyCaption={setAnalysisSkyCaption}
        slots={{ coverage: coverageSlot, aligned: alignedSlot, spectrum: spectrumSlot, footprints: footprintsSlot }} />}

      {shareStatus && <div className="share-feedback" role="status"><span>{shareStatus}</span><button type="button" aria-label="Dismiss share message" onClick={() => setShareStatus('')}>×</button></div>}
      {!shareStatus && surprise?.ra === query.ra && surprise.dec === query.dec && (
        <div className="share-feedback" role="status"><span>{surprise.reason}</span><button type="button" aria-label="Dismiss why this star was picked" onClick={() => setSurprise(null)}>×</button></div>
      )}
    </div>
  )
}
