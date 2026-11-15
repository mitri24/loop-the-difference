import type { Frame } from './types'

export type BlinkLetter = 'A' | 'B'
export interface BlinkPair {
  a: number
  b: number
}

export const REDUCED_DELAY_MS = 1000
export const REDUCED_MAX_SWAPS = 20

// A = first frame of the earliest epoch, B = first frame of the latest epoch; one epoch: B = last frame.
export function defaultBlinkPair(frames: Frame[]): BlinkPair | null {
  if (frames.length < 2) return null
  const first = (epoch: number) => frames.findIndex((f) => f.epoch === epoch)
  const epochs = frames.map((f) => f.epoch)
  const a = first(Math.min(...epochs))
  const latest = Math.max(...epochs)
  const b = latest === frames[a].epoch ? frames.length - 1 : first(latest)
  return { a, b }
}

// With a pair the player swaps between A and B; without one it loops through every frame.
export function nextIndex(index: number, count: number, pair: BlinkPair | null, delta = 1): number {
  if (pair) return index === pair.a ? pair.b : pair.a
  return (index + delta + count) % count
}

export function letterOf(index: number, pair: BlinkPair | null): BlinkLetter | null {
  if (!pair) return null
  return index === pair.a ? 'A' : index === pair.b ? 'B' : null
}

// Frame dates are UTC ISO strings ('…Z'); slicing keeps them in UTC regardless of the browser locale.
export function utcMinute(date: string): string {
  return `${date.slice(0, 16).replace('T', ' ')} UTC`
}

export function stampText(frame: Frame, letter: BlinkLetter | null): string {
  return letter ? `${letter} · ${utcMinute(frame.date)}` : utcMinute(frame.date)
}

export function lambdaText(frame: Frame): string {
  if (frame.wavelength_um !== null && frame.bandwidth_um !== null) {
    return `λ ${frame.wavelength_um.toFixed(2)} ± ${(frame.bandwidth_um / 2).toFixed(2)} µm`
  }
  return `λ ${frame.wavelength_min_um.toFixed(2)}–${frame.wavelength_max_um.toFixed(2)} µm`
}

// One collection keeps its IRSA name; a search over several (DR1, QR3 and their deep fields) lists the releases.
export function releaseLabel(collection: string): string {
  const parts = collection.split(',').map((c) => c.trim())
  const names = parts.map((c) => /^spherex_([a-z]+\d+)(_deep)?$/i.exec(c))
  if (names.length === 0 || names.some((m) => !m)) return collection
  const label = names.map((m) => `${m![1].toUpperCase()}${m![2] ? ' deep' : ''}`).join(' · ')
  return parts.length === 1 ? `SPHEREx ${label} (${collection})` : `SPHEREx ${label}`
}

// The frame's own release (NAS-71) when the manifest has it, else the searched collection(s).
export function frameRelease(frame: Pick<Frame, 'release'>, collection: string): string {
  return frame.release ? `SPHEREx ${frame.release}` : releaseLabel(collection)
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}
