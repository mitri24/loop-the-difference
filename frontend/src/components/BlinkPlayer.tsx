import { useEffect, useRef, useState } from 'react'
import {
  REDUCED_DELAY_MS,
  REDUCED_MAX_SWAPS,
  defaultBlinkPair,
  lambdaText,
  letterOf,
  nextIndex,
  prefersReducedMotion,
  releaseLabel,
  stampText,
  utcMinute,
  type BlinkLetter,
  type BlinkPair,
} from '../blink'
import { markerPosition, skyToFrame } from '../motion'
import { SEARCH_AREA_LABEL, type Prediction } from '../track'
import type { Check, Frame, FrameManifest, ProperMotion } from '../types'
import { CheckBadge, checksForFrame } from './EvidencePanel'
import { LazyThumbnail } from './LazyThumbnail'
import { ObservationImage } from './ObservationImage'

interface Props {
  frames: Frame[]
  checks?: Check[]
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg' | 'collection'> & Partial<Pick<FrameManifest, 'pixel_scale_arcsec'>>
  motion: ProperMotion | null
  // Possible track from the user's marks, at the frame dates where a straight line is valid.
  predictions?: Prediction[]
  onIndexChange?: (index: number, letter: BlinkLetter | null) => void
  // Playback and shortcuts pause while the player and the sky are covered by another panel.
  active?: boolean
  showShare?: boolean
  // Pauses and shows this frame; a new object each time, so the same frame can be asked for again.
  seek?: { index: number } | null
}

// Remount with a new key for new frames: playback state then starts fresh.
export function BlinkPlayer({
  frames,
  checks = [],
  grid,
  motion,
  predictions = [],
  onIndexChange,
  active = true,
  showShare = true,
  seek = null,
}: Props) {
  const [reduced] = useState(prefersReducedMotion)
  const [pair, setPair] = useState<BlinkPair | null>(() => defaultBlinkPair(frames))
  const [mode, setMode] = useState<'ab' | 'all'>(pair ? 'ab' : 'all')
  const [index, setIndex] = useState(pair?.a ?? 0)
  const [playing, setPlaying] = useState(false)
  const [delayMs, setDelayMs] = useState(reduced ? REDUCED_DELAY_MS : 500)
  const [autoPaused, setAutoPaused] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const playerRef = useRef<HTMLDivElement>(null)
  const swaps = useRef(0)
  const count = frames.length
  const blinkPair = mode === 'ab' ? pair : null
  const letter = letterOf(index, blinkPair)

  useEffect(() => onIndexChange?.(index, letter), [index, letter, onIndexChange])

  const [lastSeek, setLastSeek] = useState(seek)
  if (seek !== lastSeek) {
    setLastSeek(seek)
    if (seek) {
      setPlaying(false)
      setMode('all')
      setIndex(seek.index)
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

  const togglePlay = () => {
    swaps.current = 0
    setAutoPaused(false)
    setPlaying((p) => !p)
  }
  const show = (target: number) => {
    setPlaying(false)
    setIndex(target)
  }
  const step = (delta: number) => {
    setPlaying(false)
    setIndex((i) => nextIndex(i, count, blinkPair, delta))
  }
  const choose = (which: 'a' | 'b', value: number) => {
    if (!pair) return
    setPair({ ...pair, [which]: value })
    show(value)
  }

  // Space plays/pauses, arrows step – unless the key already means something where focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === ' ') {
        if (target?.closest('button, a')) return
        if (!event.repeat) togglePlay()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        step(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (pair && (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 'b')) {
        setMode('ab')
        show(pair[event.key.toLowerCase() as 'a' | 'b'])
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
  const marker = motion && markerPosition(motion, frame.mjd, grid.ra, grid.dec, grid.size_deg)
  const predicted = predictions.find((p) => p.mjd === frame.mjd)
  const searchArea = predicted && skyToFrame(predicted.ra, predicted.dec, grid.ra, grid.dec, grid.size_deg)
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
      {pair && (
        <div className="blink-mode" role="group" aria-label="Comparison">
          {(['ab', 'all'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'ab' ? 'Blink A↔B' : 'Step through all'}
            </button>
          ))}
        </div>
      )}
      <div className="viewport">
        {/* Load only the visible frame and its next playback partner. */}
        {[index, nextIndex(index, count, blinkPair)].filter((i, n, all) => all.indexOf(i) === n).map((i) => {
          const f = frames[i]
          return (
          <ObservationImage
            key={f.url}
            src={f.url}
            alt={`SPHEREx detector ${f.detector}, ${f.date.slice(0, 10)}`}
            visible={i === index}
          />
        )})}
        <div className="reticle" aria-hidden="true" />
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
            style={{ left: `${searchArea.x * 100}%`, top: `${searchArea.y * 100}%`, width: `${(predicted.radius_arcsec / 1800 / grid.size_deg) * 100}%` }}
            title={`Possible track, search area ${SEARCH_AREA_LABEL}`}
          />
        )}
        <span className="stamp">{stampText(frame, letter)}</span>
        <CheckBadge checks={checksForFrame(checks, frame)} />
      </div>

      <div className="controls">
        <button type="button" onClick={() => step(-1)} aria-label="Previous frame">
          ‹
        </button>
        <button type="button" className="primary" disabled={count < 2} onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Next frame">
          ›
        </button>
        <input
          type="range"
          min={0}
          max={count - 1}
          value={index}
          onChange={(event) => show(Number(event.target.value))}
          aria-label="Frame"
        />
        <span className="muted">
          {index + 1}/{count}
        </span>
        <label className="speed">
          Speed
          <input
            type="range"
            min={150}
            max={1500}
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

      {pair && mode === 'ab' && (
        <div className="blink-pair">
          {(['a', 'b'] as const).map((which) => {
            const f = frames[pair[which]]
            const other = pair[which === 'a' ? 'b' : 'a']
            const name = which.toUpperCase()
            return (
              <div key={which} className={`blink-chip${index === pair[which] ? ' current' : ''}`}>
                <button type="button" onClick={() => show(pair[which])} aria-label={`Show frame ${name}`}>
                  {name}
                </button>
                <span>{utcMinute(f.date)}</span>
                <span>
                  D{f.detector} · {lambdaText(f)}
                </span>
                <span>{releaseLabel(grid.collection)}</span>
                <a href={f.source_url} target="_blank" rel="noreferrer">
                  {f.obs_id}
                </a>
                <label className="epoch-pick">
                  Frame {name}
                  <select value={pair[which]} onChange={(event) => choose(which, Number(event.target.value))}>
                    {frames.map((option, i) => (
                      <option key={option.url} value={i} disabled={i === other}>
                        {utcMinute(option.date)} · epoch {option.epoch + 1}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )
          })}
          <p className="muted">
            Field centre RA {grid.ra.toFixed(5)}° · Dec {grid.dec.toFixed(5)}° · region {Number(grid.size_deg.toFixed(4))}°
          </p>
        </div>
      )}

      <section className="observation-gallery" aria-label="Observation images">
        <div className="observation-strip" tabIndex={0} aria-label="Scrollable observation images" onKeyDown={event => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.observation-preview')]
          const focused = buttons.indexOf(event.target as HTMLButtonElement)
          if (focused < 0) return
          const next = event.key === 'ArrowDown' ? Math.min(count - 1, focused + 1)
            : event.key === 'ArrowUp' ? Math.max(0, focused - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation(); setMode('all'); show(next); buttons[next]?.focus()
        }}>
          {frames.map((f, i) => (
            <article className={`observation-card${i === index ? ' current' : ''}`} key={`${f.url}-${i}`}>
              <button type="button" className="observation-preview" aria-pressed={i === index}
                aria-label={`Show observation ${i + 1}, ${utcMinute(f.date)}`}
                title={`${utcMinute(f.date)} · D${f.detector} · ${lambdaText(f)}`}
                onClick={() => { setMode('all'); show(i) }}>
                <LazyThumbnail src={f.url} alt={`SPHEREx observation ${i + 1}`} />
                <i className="thumbnail-centre" aria-hidden="true" />
                <span>{i + 1}{pair?.a === i ? ' · A' : ''}{pair?.b === i ? ' · B' : ''}</span>
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="selected-observation" aria-label="Selected observation metadata">
      <h3>Observation {index + 1} of {count}</h3>
      <dl className="meta">
        <dt>Epoch</dt><dd>{frame.epoch + 1}</dd>
        <dt>Exposures</dt><dd>{frame.n_combined}{frame.n_combined > 1 ? ' (stack)' : ' (single exposure)'}</dd>
        <dt>Release</dt><dd>{frame.release ?? releaseLabel(grid.collection)}</dd>
        <dt>Wavelength at target</dt><dd>{lambdaText(frame)}</dd>
        {frame.date_end && <><dt>Observation end</dt><dd>{utcMinute(frame.date_end)}</dd></>}
        <dt>Masked pixels</dt><dd>{frame.masked_fraction == null ? 'Not reported' : `${(frame.masked_fraction * 100).toFixed(1)} %`}</dd>
        <dt>Field centre</dt><dd>RA {grid.ra.toFixed(6)}° · Dec {grid.dec.toFixed(6)}°</dd>
        <dt>Image scale</dt><dd>{grid.pixel_scale_arcsec == null ? 'Pixel scale not reported' : `${grid.pixel_scale_arcsec}″/px`} · {grid.size_deg}° field</dd>
        <dt>Observed</dt>
        <dd>{frame.date.replace('T', ' ').replace('Z', ' UTC')}</dd>
        <dt>Detector</dt>
        <dd>
          D{frame.detector} · {frame.wavelength_min_um.toFixed(2)}–
          {frame.wavelength_max_um.toFixed(2)} µm
        </dd>
        <dt>Coverage</dt>
        <dd>{Math.round(frame.coverage * 100)} %</dd>
        {motion && (
          <>
            <dt>Gaia DR3</dt>
            <dd>
              {motion.source_id} · µ {motion.pmra_mas_yr.toFixed(0)},{' '}
              {motion.pmdec_mas_yr.toFixed(0)} mas/yr
              {motion.parallax_mas !== null && ` · ϖ ${motion.parallax_mas.toFixed(1)} mas`} ·{' '}
              {marker ? '○ predicted position' : 'predicted position outside this frame'}
            </dd>
          </>
        )}
        {predicted && (
          <>
            <dt>Possible track</dt>
            <dd>{searchArea ? `dashed circle: search area, ${SEARCH_AREA_LABEL}` : 'predicted position outside this frame'}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          <a href={frame.source_url} target="_blank" rel="noreferrer">
            {frame.obs_id}
          </a>
        </dd>
      </dl>
      {pair && <div className="gallery-pair-actions">
        {(['a', 'b'] as const).map(which => <button key={which} type="button"
          disabled={pair[which === 'a' ? 'b' : 'a'] === index} aria-pressed={pair[which] === index}
          aria-label={`Use observation ${index + 1} as ${which.toUpperCase()}`}
          onClick={() => { choose(which, index); setMode('ab') }}>
          {pair[which] === index ? `${which.toUpperCase()} selected` : `Set ${which.toUpperCase()}`}
        </button>)}
      </div>}
      </section>
    </div>
  )
}
