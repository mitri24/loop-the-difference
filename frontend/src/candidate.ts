// Candidate check: the user's marks "something is here, in this frame", snapped to the nearest
// SPHEREx detection. The app never decides what a candidate is; it names what still needs checking.
import type { AladinInstance, Catalog } from 'aladin-lite'
import { useEffect, useState } from 'react'
import { skyToFrame } from './motion'
import { MATCH_STYLE, degText } from './sourceLayer'
import type { DetectedSource, Frame, FrameManifest } from './types'

export interface Mark {
  obs_id: string
  mjd: number
  date: string
  ra: number
  dec: number
  // 1σ per axis
  sigma_arcsec: number
  source?: DetectedSource
}

export const MARK_LETTERS = ['A', 'B'] as const
export const MARK_LAYER = 'Your marks (candidate check)'
const SNAP_PIXELS = 2
const MIN_GAP_S = 60
export const OUTSIDE_FRAME = 'Click inside the SPHEREx frame (blue outline)'

/** Position error per axis from the Gaia-matched offsets; saturated cores scatter far more. */
export function sigmaFor(snr: number | null): number {
  if (snr == null) return 3
  if (snr < 20) return 1.5
  if (snr < 300) return 1
  return 6
}

export function markFromSource(frame: Frame, source: DetectedSource): Mark {
  const { obs_id, mjd, date } = frame
  return { obs_id, mjd, date, ra: source.ra, dec: source.dec, sigma_arcsec: sigmaFor(source.snr), source }
}

/** Small-angle separation in arcsec, RA wrapped at 0/360. */
export function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const dRa = ((ra2 - ra1 + 540) % 360) - 180
  return Math.hypot(dRa * Math.cos((dec1 * Math.PI) / 180), dec2 - dec1) * 3600
}

/** The nearest detection within two pixels supplies the position; otherwise the click itself. */
export function snapMark(frame: Frame, ra: number, dec: number, pixelScaleArcsec: number): Mark {
  let best: DetectedSource | null = null
  let bestSep = SNAP_PIXELS * pixelScaleArcsec
  for (const source of frame.sources ?? []) {
    const sep = sepArcsec(ra, dec, source.ra, source.dec)
    if (sep <= bestSep) [best, bestSep] = [source, sep]
  }
  if (best) return markFromSource(frame, best)
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

export type Candidate = ReturnType<typeof useCandidate>

/** Marks of one comparison: a new job id clears them; `allowed` false disarms sky clicks. */
export function useCandidate(jobId: string | null, allowed: boolean) {
  const [state, setState] = useState({ jobId, marks: [] as Mark[], notice: '' })
  const [armed, setArmed] = useState(false)
  if (state.jobId !== jobId) setState({ jobId, marks: [], notice: '' })
  if (armed && !allowed) setArmed(false)
  const add = (mark: Mark) =>
    setState((old) => {
      const next = addMark(old.marks, mark)
      return 'error' in next ? { ...old, notice: next.error } : { ...old, marks: next.marks, notice: '' }
    })
  return {
    marks: state.marks,
    notice: state.notice,
    armed,
    setArmed,
    markSource: (frame: Frame, source: DetectedSource) => add(markFromSource(frame, source)),
    markAt: (frame: Frame, manifest: FrameManifest, ra: number, dec: number) => {
      if (!armed) return
      if (!insideFrame(ra, dec, manifest)) return setState((old) => ({ ...old, notice: OUTSIDE_FRAME }))
      add(snapMark(frame, ra, dec, manifest.pixel_scale_arcsec))
    },
    clear: () => setState((old) => ({ ...old, marks: [], notice: '' })),
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
        label: `◎ ${MARK_LETTERS[i]}`, obs_id: m.obs_id, date: m.date, 'σ (″)': m.sigma_arcsec.toFixed(1),
      })))
      aladin.addCatalog(catalog)
    })
    return () => {
      disposed = true
      if (catalog) aladin.removeOverlay(catalog)
    }
  }, [aladin, marks])
}
