// Candidate check: the user's marks "something is here, in this frame", snapped to the nearest
// SPHEREx detection. The app never decides what a candidate is; it names what still needs checking.
import type { AladinInstance, Catalog } from 'aladin-lite'
import { useEffect, useMemo, useState } from 'react'
import { skyToFrame } from './motion'
import { MATCH_STYLE, degText } from './sourceLayer'
import type { DetectedSource, Frame, FrameManifest } from './types'
import type { LinkMark } from './url'

export interface Mark {
  obs_id: string
  mjd: number
  date: string
  ra: number
  dec: number
  // 1σ per axis
  sigma_arcsec: number
  source?: DetectedSource
  label?: string
}

export const MARK_LETTERS = ['A', 'B'] as const
export const MARK_LAYER = 'Your marks (candidate check)'
const SNAP_PIXELS = 2
const MIN_GAP_S = 60
export const OUTSIDE_FRAME = 'Click inside the SPHEREx frame (blue outline)'

/**
 * Position error per axis (1σ) as the rms offset to Gaia DR3 in real SPHEREx frames (pipeline 12):
 * 1.2″ below S/N 10 (22 matches), 0.6″ at S/N 10–20 (39), kept for the 2 brighter ones (WISE 0855,
 * D6); a saturated core placed by its rim 2.5″ and 1.9″, at most 7.9″ apart (Barnard's Star,
 * D1–D3, 281 exposures); cores cut by the grid edge are skipped. A click without a detection: 3″.
 */
export function sigmaFor(snr: number | null, saturated = false): number {
  if (snr == null) return 3
  if (saturated) return 2.5
  return snr < 10 ? 1.2 : 0.6
}

export function markFromSource(frame: Frame, source: DetectedSource): Mark {
  const { obs_id, mjd, date } = frame
  const sigma_arcsec = sigmaFor(source.snr, source.saturated)
  return { obs_id, mjd, date, ra: source.ra, dec: source.dec, sigma_arcsec, source }
}

/** Small-angle separation in arcsec, RA wrapped at 0/360. */
export function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const dRa = ((ra2 - ra1 + 540) % 360) - 180
  return Math.hypot(dRa * Math.cos((dec1 * Math.PI) / 180), dec2 - dec1) * 3600
}

/** The detection nearest to (ra, dec) within maxArcsec, or null. */
export function nearestSource(sources: DetectedSource[], ra: number, dec: number, maxArcsec: number) {
  let best: { source: DetectedSource; sep_arcsec: number } | null = null
  for (const source of sources) {
    const sep_arcsec = sepArcsec(ra, dec, source.ra, source.dec)
    if (sep_arcsec <= (best?.sep_arcsec ?? maxArcsec)) best = { source, sep_arcsec }
  }
  return best
}

/** The nearest detection within two pixels supplies the position; otherwise the click itself. */
export function snapMark(frame: Frame, ra: number, dec: number, pixelScaleArcsec: number): Mark {
  const best = nearestSource(frame.sources ?? [], ra, dec, SNAP_PIXELS * pixelScaleArcsec)
  if (best) return markFromSource(frame, best.source)
  const { obs_id, mjd, date } = frame
  return { obs_id, mjd, date, ra, dec, sigma_arcsec: sigmaFor(null) }
}

export const insideFrame = (ra: number, dec: number, m: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg'>) =>
  skyToFrame(ra, dec, m.ra, m.dec, m.size_deg) !== null

/** One mark per frame, at most two, at least a minute apart; sorted so A is the earlier one. */
export function addMark(marks: Mark[], mark: Mark): { marks: Mark[] } | { error: string } {
  const others = marks.filter((m) => m.obs_id !== mark.obs_id)
  const close = others.find((m) => Math.abs(m.mjd - mark.mjd) * 86400 < MIN_GAP_S)
  if (close) {
    return { error: `This frame is less than ${MIN_GAP_S} s from mark ${MARK_LETTERS[marks.indexOf(close)]}: choose a frame from another time.` }
  }
  if (others.length >= MARK_LETTERS.length) return { error: 'Two marks are set. Clear marks to start again.' }
  return { marks: [...others, mark].sort((a, b) => a.mjd - b.mjd) }
}

export function markText(mark: Mark, letter: string): string {
  const evidence = mark.source
    ? `${MATCH_STYLE[mark.source.match].glyph} ${MATCH_STYLE[mark.source.match].word} (S/N ${mark.source.snr.toFixed(0)})`
    : 'position as clicked'
  return `${letter} · ${mark.date.slice(0, 16).replace('T', ' ')} UTC · RA ${degText(mark.ra)} Dec ${degText(mark.dec)} ± ${mark.sigma_arcsec.toFixed(1)}″ · ${evidence}`
}

export const CANDIDATE_STATES = {
  unverified: { icon: '?', word: 'Unverified candidate – needs verification' },
  motion: { icon: '↗', word: 'Possible motion – needs verification' },
  brightness: { icon: '◐', word: 'Possible brightness change – needs verification' },
  catalogueStar: { icon: '★', word: 'Catalogue star at this position' },
  knownBody: { icon: '◇', word: 'Possible known Solar System body' },
} as const
export type CandidateState = keyof typeof CANDIDATE_STATES

// Only the user sets a verdict; the app never does.
export const VERDICTS = ['needs follow-up', 'known object', 'possible artifact'] as const
export type Verdict = (typeof VERDICTS)[number]

export interface Evidence {
  knownBody?: boolean
  catalogueStar?: boolean
  motion?: boolean
  fastMotion?: boolean
  brightness?: boolean
}

export function candidateState(e: Evidence): CandidateState {
  if (e.knownBody) return 'knownBody'
  if (e.catalogueStar && !e.fastMotion) return 'catalogueStar'
  if (e.motion || e.fastMotion) return 'motion'
  if (e.brightness) return 'brightness'
  return 'unverified'
}

/** Marks from a shared link in this comparison's frames, by the same rules as clicks (inside the frame, one per
 * frame, a minute apart); those that cannot be placed are counted. */
export function placeLinkMarks(manifest: Pick<FrameManifest, 'frames' | 'pixel_scale_arcsec' | 'ra' | 'dec' | 'size_deg'>, linked: LinkMark[]) {
  let marks: Mark[] = []
  let missing = 0
  for (const link of linked) {
    const frame = insideFrame(link.ra, link.dec, manifest) ? manifest.frames.find((f) => f.obs_id === link.obs_id) : undefined
    const next = frame && addMark(marks, snapMark(frame, link.ra, link.dec, manifest.pixel_scale_arcsec))
    if (next && 'marks' in next) marks = next.marks
    else missing += 1
  }
  return { marks, missing }
}

export type Candidate = ReturnType<typeof useCandidate>
// The verdict starts at the first choice; `verdictChosen` says whether the user picked it.
const START = { marks: [] as Mark[], notice: '', verdict: VERDICTS[0] as Verdict, verdictChosen: false }

/** Marks of one comparison: a new job id clears them; `allowed` false disarms clicks. Marks from a shared link
 * belong to the first comparison: they are placed once its final frames are there (`final`), and dropped when
 * another comparison starts first. New marks start without a verdict. */
export function useCandidate(jobId: string | null, allowed: boolean, final: FrameManifest | null = null, linked: LinkMark[] = []) {
  const [state, setState] = useState({ jobId, ...START })
  const [objects, setObjects] = useState<{ jobId: string | null; active: number; items: (typeof START)[] }>({ jobId, active: 0, items: [] })
  if (objects.jobId !== jobId) setObjects({ jobId, active: 0, items: [] })
  const saveCurrent = () => {
    const items = [...objects.items]
    items[objects.active] = { marks: state.marks, notice: state.notice, verdict: state.verdict, verdictChosen: state.verdictChosen }
    return items
  }
  const selectObject = (index: number) => {
    const items = saveCurrent()
    setObjects({ jobId, active: index, items })
    setState({ jobId, ...(items[index] ?? START) })
    setArmed(false)
  }
  const objectItems = [...objects.items]
  objectItems[objects.active] = state
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState<{ marks: LinkMark[]; jobId: string | null }>({ marks: linked, jobId: null })
  if (state.jobId !== jobId) setState({ jobId, ...START })
  if (armed && !allowed) setArmed(false)
  if (pending.marks.length > 0 && jobId && pending.jobId !== jobId) {
    setPending(pending.jobId === null ? { ...pending, jobId } : { marks: [], jobId: null })
  } else if (pending.marks.length > 0 && jobId && pending.jobId === jobId && state.jobId === jobId && final?.frames.length) {
    const placed = placeLinkMarks(final, pending.marks)
    setPending({ marks: [], jobId: null })
    if (pending.marks.some((mark) => mark.object != null)) {
      const objectIds = [...new Set(pending.marks.map((mark) => mark.object ?? 0))].sort((a, b) => a - b)
      const groups = objectIds.map((index) =>
        placeLinkMarks(final, pending.marks.filter((mark) => (mark.object ?? 0) === index)))
      const items = groups.map((group) => ({ ...START, marks: group.marks }))
      setObjects({ jobId, active: 0, items })
      placed.marks = items[0].marks
      placed.missing = groups.reduce((sum, group) => sum + group.missing, 0)
    }
    setState({ jobId, ...START, marks: placed.marks,
      notice: placed.missing ? `${placed.missing} ${placed.missing === 1 ? 'mark' : 'marks'} from the link could not be placed in this comparison.` : '' })
  }
  const allMarks = useMemo(() => {
    const items = [...objects.items]
    items[objects.active] = state
    return items.flatMap((item, index) => item.marks.map((mark, i) => ({ ...mark, label: `${index + 1}${MARK_LETTERS[i]}`, object: index })))
  }, [objects, state])
  const shareMarks = objectItems.length > 1 ? allMarks : state.marks
  const add = (mark: Mark) =>
    setState((old) => {
      const next = addMark(old.marks, mark)
      return 'error' in next ? { ...old, notice: next.error } : { ...old, marks: next.marks, notice: '', verdict: START.verdict, verdictChosen: false }
    })
  return {
    objects: objectItems.map((item, index) => ({ index, count: item.marks.length })),
    activeObject: objects.active,
    selectObject,
    newObject: () => selectObject(objectItems.length),
    allMarks,
    shareMarks,
    marks: state.marks,
    notice: state.notice,
    verdict: state.verdict,
    verdictChosen: state.verdictChosen,
    setVerdict: (verdict: Verdict) => setState((old) => ({ ...old, verdict, verdictChosen: true })),
    // The link's marks while they wait for their frames (the address bar keeps them meanwhile).
    linked: pending.marks,
    armed,
    setArmed,
    markSource: (frame: Frame, source: DetectedSource) => add(markFromSource(frame, source)),
    markAt: (frame: Frame, manifest: FrameManifest, ra: number, dec: number) => {
      if (!armed) return
      if (!insideFrame(ra, dec, manifest)) return setState((old) => ({ ...old, notice: OUTSIDE_FRAME }))
      add(snapMark(frame, ra, dec, manifest.pixel_scale_arcsec))
    },
    clear: () => setState((old) => ({ ...old, ...START })),
  }
}

/** ◎ with its letter on the sky: circle, label and colour, never colour alone. */
export function useMarkLayer(aladin: AladinInstance | null, marks: Mark[]) {
  useEffect(() => {
    if (!aladin || marks.length === 0) return
    let catalog: Catalog | null = null
    let disposed = false
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const color = getComputedStyle(document.documentElement).getPropertyValue('--candidate').trim()
      catalog = A.catalog({
        name: MARK_LAYER, shape: 'circle', color, sourceSize: 22, limit: marks.length,
        onClick: 'showTable', displayLabel: true, labelColumn: 'label', labelColor: color,
      })
      catalog.addSources(marks.map((m, i) => A.source(m.ra, m.dec, {
        label: `◎ ${m.label ?? MARK_LETTERS[i]}`, obs_id: m.obs_id, date: m.date, 'σ (″)': m.sigma_arcsec.toFixed(1),
      })))
      aladin.addCatalog(catalog)
    })
    return () => {
      disposed = true
      if (catalog) aladin.removeOverlay(catalog)
    }
  }, [aladin, marks])
}
