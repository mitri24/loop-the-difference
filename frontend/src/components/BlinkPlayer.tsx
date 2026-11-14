import { useEffect, useState } from 'react'
import { markerPosition } from '../motion'
import type { Check, Frame, FrameManifest, ProperMotion } from '../types'
import { CheckBadge, checksForFrame } from './EvidencePanel'
import { ObservationImage } from './ObservationImage'

interface Props {
  frames: Frame[]
  checks?: Check[]
  grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg'>
  motion: ProperMotion | null
  onIndexChange?: (index: number) => void
  // Playback and shortcuts run only while the player's controls are on screen.
  active?: boolean
  showShare?: boolean
}

// Remount with a new key for new frames: playback state then starts fresh.
export function BlinkPlayer({
  frames,
  checks = [],
  grid,
  motion,
  onIndexChange,
  active = true,
  showShare = true,
}: Props) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [delayMs, setDelayMs] = useState(500)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const count = frames.length

  useEffect(() => onIndexChange?.(index), [index, onIndexChange])

  useEffect(() => {
    if (!active || !playing || count < 2) return
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), delayMs)
    return () => window.clearInterval(timer)
  }, [active, playing, delayMs, count])

  // Space plays/pauses, arrows step – unless the key already means something where focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === ' ') {
        if (target?.closest('button, a')) return
        if (!event.repeat) setPlaying((p) => !p)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        setPlaying(false)
        setIndex((i) => (i + (event.key === 'ArrowLeft' ? -1 : 1) + count) % count)
      } else return
      event.preventDefault()
    }
    // Map arrows/Space belong to Aladin. Player shortcuts apply only inside this player.
    if (!active) return
    const player = document.querySelector('.player')
    const scopedKey = (event: Event) => onKey(event as KeyboardEvent)
    player?.addEventListener('keydown', scopedKey)
    return () => player?.removeEventListener('keydown', scopedKey)
  }, [active, count])

  const frame = frames[index]
  const marker = motion && markerPosition(motion, frame.mjd, grid.ra, grid.dec, grid.size_deg)
  const step = (delta: number) => {
    setPlaying(false)
    setIndex((i) => (i + delta + count) % count)
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className="player" tabIndex={0} aria-label="Observation player. Space to play, arrow keys to step.">
      <div className="viewport">
        {/* All frames stay mounted, so they load once and switching is instant. */}
        {frames.map((f, i) => (
          <ObservationImage
            key={f.url}
            src={f.url}
            alt={`SPHEREx detector ${f.detector}, ${f.date.slice(0, 10)}`}
            visible={i === index}
          />
        ))}
        <div className="reticle" aria-hidden="true" />
        {marker && (
          <div
            className="marker"
            style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
            title="Predicted position from Gaia DR3 proper motion"
          />
        )}
        <span className="stamp">{frame.date.slice(0, 10)}</span>
        <CheckBadge checks={checksForFrame(checks, frame)} />
      </div>

      <div className="controls">
        <button type="button" onClick={() => step(-1)} aria-label="Previous frame">
          ‹
        </button>
        <button type="button" className="primary" disabled={count < 2} onClick={() => setPlaying((p) => !p)}>
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
          onChange={(event) => {
            setPlaying(false)
            setIndex(Number(event.target.value))
          }}
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

      <dl className="meta">
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
              {marker ? '◇ predicted position' : 'predicted position outside this frame'}
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          <a href={frame.source_url} target="_blank" rel="noreferrer">
            {frame.obs_id}
          </a>
        </dd>
      </dl>
    </div>
  )
}
