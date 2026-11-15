import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  REDUCED_DELAY_MS,
  REDUCED_MAX_SWAPS,
  defaultBlinkPair,
  lambdaText,
  letterOf,
  nextIndex,
  prefersReducedMotion,
  stampText,
  utcMinute,
  type BlinkLetter,
  type BlinkPair,
} from '../blink'
import { MARK_LETTERS, type Mark } from '../candidate'
import { frameToSky, gridExtentDeg, markerPosition, skyToFrame } from '../motion'
import { SEARCH_AREA_LABEL, type Prediction } from '../track'
import type { Check, Frame, FrameManifest, ProperMotion } from '../types'
import { CheckBadge, checksForFrame } from './EvidencePanel'
import { ImageMarks, type ImageMark } from './ImageMarks'
import { LazyThumbnail } from './LazyThumbnail'
import { ObservationImage } from './ObservationImage'
import { PairTable } from './PairTable'

interface Props {
  frames: Frame[]
  checks?: Check[]
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'collection'> & Partial<Pick<FrameManifest, 'pixel_scale_arcsec'>>
  motion: ProperMotion | null
  // Possible track from the user's marks, at the frame dates where a straight line is valid.
  predictions?: Prediction[]
  onIndexChange?: (index: number, letter: BlinkLetter | null) => void
  // The blink pair whenever it changes: the frame details (Set A / Set B) read it.
  onPairChange?: (pair: BlinkPair | null) => void
  // Playback and shortcuts pause while the player and the sky are covered by another panel.
  active?: boolean
  showShare?: boolean
  // Pauses and shows this frame; a new object each time, so the same frame can be asked for again.
  seek?: { index: number } | null
  // Sets A and/or B ("Choose a compatible pair" in the checks) and blinks the pair; a new object each time.
  pairRequest?: { pair: Partial<BlinkPair> } | null
  // The pair to start with instead of the default one (a shared link's A and B).
  initialPair?: BlinkPair | null
  // Above and below the A/B table beside the image: which images (exposures or stacks), and what the change finder
  // says about the pair.
  controls?: ReactNode
  changes?: ReactNode
  // What the layers show on the sky for the shown frame (catalogues, detected sources, known asteroids), drawn on
  // the image as well.
  marks?: ImageMark[]
  // Candidate check: while marking is armed, a click on the shown image marks that position in that frame. The
  // user's marks A and B stand on the image; the check itself goes under the A/B table (candidate).
  marking?: boolean
  onMark?: (frame: Frame, ra: number, dec: number) => void
  candidateMarks?: Mark[]
  candidate?: ReactNode
}

// One layout without page scrolling, left-aligned: thumbnails | image | A and B as a comparison table, one transport
// bar under the image. Play blinks A and B; the arrows, the slider and the thumbnails step through every frame;
// "All" at the thumbnails plays every frame in time order. Remount with a new key for new frames: playback state
// then starts fresh.
export function BlinkPlayer({
  frames,
  checks = [],
  grid,
  motion,
  predictions = [],
  onIndexChange,
  onPairChange,
  active = true,
  showShare = true,
  seek = null,
  pairRequest = null,
  initialPair = null,
  controls = null,
  changes = null,
  marks = [],
  marking = false,
  onMark,
  candidateMarks = [],
  candidate = null,
}: Props) {
  const [reduced] = useState(prefersReducedMotion)
  const [pair, setPair] = useState<BlinkPair | null>(() => (initialPair && initialPair.a !== initialPair.b
    && [initialPair.a, initialPair.b].every((i) => i >= 0 && i < frames.length) ? initialPair : defaultBlinkPair(frames)))
  // What Play plays: A and B, or every frame ("All" at the thumbnails).
  const [scope, setScope] = useState<'ab' | 'all'>(pair ? 'ab' : 'all')
  const [index, setIndex] = useState(pair?.a ?? 0)
  const [playing, setPlaying] = useState(false)
  // Arming the mark pauses: a click must land on the frame the user aimed at.
  const [wasMarking, setWasMarking] = useState(marking)
  if (marking !== wasMarking) {
    setWasMarking(marking)
    if (marking) setPlaying(false)
  }
  // Pixels across the frames' common grid, from the loaded PNG: every overlay and click uses the image's real extent.
  const [pixels, setPixels] = useState<number | null>(null)
  const extentDeg = gridExtentDeg(pixels, grid.pixel_scale_arcsec, grid.size_deg)
  const [delayMs, setDelayMs] = useState(reduced ? REDUCED_DELAY_MS : 500)
  const [autoPaused, setAutoPaused] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const playerRef = useRef<HTMLDivElement>(null)
  const swaps = useRef(0)
  const count = frames.length
  const blinkPair = scope === 'ab' ? pair : null
  // A and B are always named, whatever plays.
  const letter = letterOf(index, pair)

  useEffect(() => onIndexChange?.(index, letter), [index, letter, onIndexChange])
  useEffect(() => onPairChange?.(pair), [pair, onPairChange])

  const [lastSeek, setLastSeek] = useState(seek)
  if (seek !== lastSeek) {
    setLastSeek(seek)
    if (seek) {
      setPlaying(false)
      setIndex(seek.index)
    }
  }
  const [lastPairRequest, setLastPairRequest] = useState(pairRequest)
  if (pairRequest !== lastPairRequest) {
    setLastPairRequest(pairRequest)
    const next = pair && pairRequest ? { ...pair, ...pairRequest.pair } : null
    if (next && next.a !== next.b && [next.a, next.b].every((i) => i >= 0 && i < count)) {
      setPair(next)
      setScope('ab')
      setPlaying(false)
      // Set A / Set B keep the shown frame; a new pair starts at its A.
      setIndex((i) => (i === next.a || i === next.b ? i : next.a))
    }
  }

  useEffect(() => {
    if (!active || !playing || count < 2) return
    const timer = window.setInterval(() => {
      swaps.current += 1
      if (reduced && swaps.current >= REDUCED_MAX_SWAPS) {
        setPlaying(false)
        setAutoPaused(true)
      }
      setIndex((i) => nextIndex(i, count, blinkPair))
    }, delayMs)
    return () => window.clearInterval(timer)
  }, [active, playing, delayMs, count, blinkPair, reduced])

  const togglePlay = (next: 'ab' | 'all' = pair ? 'ab' : 'all') => {
    swaps.current = 0
    setAutoPaused(false)
    if (playing && scope === next) return setPlaying(false)
    setScope(next)
    setPlaying(true)
  }
  const show = (target: number) => {
    setPlaying(false)
    setIndex(target)
  }
  // Stepping goes through every frame in time order.
  const step = (delta: number) => {
    setPlaying(false)
    setIndex((i) => nextIndex(i, count, null, delta))
  }
  const choose = (which: 'a' | 'b', value: number) => {
    if (!pair) return
    setPair({ ...pair, [which]: value })
    show(value)
  }
  const showLetter = (which: 'a' | 'b') => {
    if (!pair) return
    setScope('ab')
    show(pair[which])
  }
  const setShown = (which: 'a' | 'b') => {
    if (!pair || pair[which === 'a' ? 'b' : 'a'] === index) return
    setPair({ ...pair, [which]: index })
    setScope('ab')
  }
  // The image stays; its letter changes with the pair.
  const swap = () => pair && setPair({ a: pair.b, b: pair.a })

  // Space plays/pauses, arrows step – unless the key already means something where focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === ' ') {
        if (target?.closest('button, a')) return
        if (!event.repeat) togglePlay(scope)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        step(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (pair && (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 'b')) {
        showLetter(event.key.toLowerCase() as 'a' | 'b')
      } else return
      event.preventDefault()
    }
    // Map arrows/Space belong to Aladin. Player shortcuts apply only inside this player.
    const player = playerRef.current
    if (!active || !player) return
    player.addEventListener('keydown', onKey)
    return () => player.removeEventListener('keydown', onKey)
  })

  const frame = frames[index]
  const marker = motion && markerPosition(motion, frame.mjd, grid.ra, grid.dec, extentDeg)
  const predicted = predictions.find((p) => p.mjd === frame.mjd)
  const searchArea = predicted && skyToFrame(predicted.ra, predicted.dec, grid.ra, grid.dec, extentDeg)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div
      ref={playerRef}
      className="player observation-player"
      role="group"
      tabIndex={0}
      aria-label="Observation player. Space to play, arrow keys to step, A and B show those frames."
    >
      {count > 1 && (
        <section className="observation-gallery" aria-label="Observation images">
          <button type="button" className="play-all" aria-pressed={playing && scope === 'all'} title="Play every frame in time order"
            onClick={() => togglePlay('all')}>{playing && scope === 'all' ? '❚❚ All' : '▶ All'}</button>
          <div className="observation-strip" tabIndex={0} aria-label="Scrollable observation images" onKeyDown={(event) => {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.observation-preview')]
            const focused = buttons.indexOf(event.target as HTMLButtonElement)
            if (focused < 0) return
            const next = event.key === 'ArrowDown' ? Math.min(count - 1, focused + 1)
              : event.key === 'ArrowUp' ? Math.max(0, focused - 1)
              : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
            if (next === null) return
            event.preventDefault()
            event.stopPropagation()
            show(next)
            buttons[next]?.focus()
          }}>
            {frames.map((f, i) => {
              // A and B wear their letter as a badge and a frame in their colour, as in the table and on the image.
              const role = pair?.a === i ? 'A' : pair?.b === i ? 'B' : null
              return (
                <article className={`observation-card${i === index ? ' current' : ''}${role ? ` is-${role.toLowerCase()}` : ''}`} key={`${f.url}-${i}`}>
                  <button type="button" className="observation-preview" aria-pressed={i === index}
                    aria-label={`Show observation ${i + 1}, ${utcMinute(f.date)}${role ? `, ${role}` : ''}`}
                    title={`${role ? `${role} · ` : ''}${utcMinute(f.date)} · D${f.detector} · ${lambdaText(f)}`}
                    onClick={() => show(i)}>
                    <LazyThumbnail src={f.url} alt={`SPHEREx observation ${i + 1}`} />
                    <i className="thumbnail-centre" aria-hidden="true" />
                    {role && <b className={`ab-badge ${role.toLowerCase()}`} aria-hidden="true">{role}</b>}
                    <span>{i + 1}</span>
                  </button>
                </article>
              )
            })}
          </div>
        </section>
      )}

      <div
        className={marking ? 'viewport marking' : 'viewport'}
        title={marking ? 'Click the object to mark it in this frame' : undefined}
        onClick={(event) => {
          // Only the shown, loaded image marks: not the stamp, the checks badge, a placeholder or an error message.
          const image = event.target
          if (!marking || !onMark || !(image instanceof HTMLImageElement) || !image.naturalWidth || image.style.visibility === 'hidden') return
          // Playing, the frame may change under the pointer: that click only pauses.
          if (playing) return setPlaying(false)
          const box = image.getBoundingClientRect()
          const at = frameToSky((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height, grid.ra, grid.dec, extentDeg)
          onMark(frame, at.ra, at.dec)
        }}
      >
        {/* Load only the visible frame and its next playback partner. */}
        {[index, nextIndex(index, count, blinkPair)].filter((i, n, all) => all.indexOf(i) === n).map((i) => {
          const f = frames[i]
          return (
            <ObservationImage
              key={f.url}
              src={f.url}
              alt={`SPHEREx detector ${f.detector}, ${f.date.slice(0, 10)}`}
              visible={i === index}
              onSize={setPixels}
            />
          )
        })}
        <div className="reticle" aria-hidden="true" />
        <ImageMarks marks={marks} grid={{ ...grid, size_deg: extentDeg }} />
        {marker && (
          <div
            className="marker"
            style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
            title="Predicted position from Gaia DR3 proper motion"
          />
        )}
        {searchArea && predicted && (
          <div
            className="search-area"
            style={{ left: `${searchArea.x * 100}%`, top: `${searchArea.y * 100}%`, width: `${(predicted.radius_arcsec / 1800 / extentDeg) * 100}%` }}
            title={`Possible track, search area ${SEARCH_AREA_LABEL}`}
          />
        )}
        {candidateMarks.map((mark, i) => {
          const at = skyToFrame(mark.ra, mark.dec, grid.ra, grid.dec, extentDeg)
          const here = mark.obs_id === frame.obs_id
          return at && (
            <span key={mark.obs_id} className={here ? 'candidate-mark current' : 'candidate-mark'}
              style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }} title={`Your mark ${MARK_LETTERS[i]}${here ? ', set in this frame' : ''}`}>
              <span className="candidate-mark-letter">{MARK_LETTERS[i]}</span>
            </span>
          )
        })}
        {/* The letter in its colour, as on the thumbnails and in the table; the text reads "A · date". */}
        <span className="stamp">{letter ? <><b className={`stamp-letter ${letter.toLowerCase()}`}>{letter}</b> · {utcMinute(frame.date)}</> : stampText(frame, null)}</span>
        <CheckBadge checks={checksForFrame(checks, frame)} />
      </div>

      <div className="controls transport">
        <div className="transport-buttons">
          <button type="button" onClick={() => step(-1)} aria-label="Previous frame">
            ‹
          </button>
          <button type="button" className="primary" disabled={count < 2} onClick={() => togglePlay()}
            title={pair ? 'Blink A and B' : 'Play every frame'}>
            {playing && scope === (pair ? 'ab' : 'all') ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Next frame">
            ›
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={count - 1}
          value={index}
          onChange={(event) => show(Number(event.target.value))}
          aria-label="Frame"
        />
        <span className="frame-count">
          {index + 1}/{count}
        </span>
        <label className="speed">
          Speed
          {/* Reduced motion: never faster than one swap a second. */}
          <input
            type="range"
            min={150}
            max={reduced ? 1650 - REDUCED_DELAY_MS : 1500}
            step={50}
            value={1650 - delayMs}
            onChange={(event) => setDelayMs(1650 - Number(event.target.value))}
          />
        </label>
        {showShare && <button type="button" onClick={() => void copyLink()} onBlur={() => setCopyState('idle')}>
          {copyState === 'copied'
            ? 'Link copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy link'}
        </button>}
      </div>

      {autoPaused && <p className="notice">Paused after 20 swaps (reduced motion) – press Play to continue</p>}

      <div className="player-side">
        {controls}
        {pair ? (
          <PairTable frames={frames} pair={pair} index={index} letter={letter} grid={grid} motion={motion} predictions={predictions}
            onShow={showLetter} onChoose={choose} onSwap={swap} onSetShown={setShown} />
        ) : (
          <p className="pair-shown">Only one image here: nothing to blink against. {utcMinute(frame.date)} · {lambdaText(frame)} ·{' '}
            <a href={frame.source_url} target="_blank" rel="noreferrer">{frame.obs_id}</a></p>
        )}
        {changes}
        {candidate}
      </div>
    </div>
  )
}
