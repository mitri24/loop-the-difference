import { describe, expect, it } from 'vitest'
import { INTRO_TIMING, runIntro, type IntroEnv } from './intro'

// A fake page: the intro element's classes, a clock with scheduled callbacks, the skip listener.
function page(overrides: Partial<IntroEnv> = {}) {
  const classes: string[] = []
  let removed = false
  let remembered = false
  let skip: (() => void) | null = null
  let time = 0
  const timers: { at: number; run: () => void }[] = []
  const env: IntroEnv = {
    element: { classList: { add: (name) => void classes.push(name) }, remove: () => void (removed = true) },
    now: 0,
    reducedMotion: false,
    schedule: (run, ms) => void timers.push({ at: time + ms, run }),
    listen: (fn) => {
      skip = fn
      return () => void (skip = null)
    },
    remember: () => void (remembered = true),
    ...overrides,
  }
  const advance = (ms: number) => {
    const until = time + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      if (!timers.length || timers[0].at > until) break
      const next = timers.shift()!
      time = next.at
      next.run()
    }
    time = until
  }
  const phase = runIntro(env)
  return { classes, phase, advance, skip: () => skip?.(), removed: () => removed, remembered: () => remembered }
}

describe('intro', () => {
  it('loads, plays the logo, opens onto the app and goes', () => {
    const intro = page()
    expect(intro.phase()).toBe('loading')
    expect(intro.remembered()).toBe(true)
    intro.advance(INTRO_TIMING.minLoadingMs)
    expect(intro.phase()).toBe('play')
    expect(intro.classes).toEqual(['intro--play'])
    intro.advance(INTRO_TIMING.playMs)
    expect(intro.phase()).toBe('open')
    expect(intro.classes).toEqual(['intro--play', 'intro--open'])
    intro.advance(INTRO_TIMING.openMs - 1)
    expect(intro.removed()).toBe(false)
    intro.advance(1)
    expect(intro.phase()).toBe('gone')
    expect(intro.removed()).toBe(true)
  })

  it('keeps the loading animation for its minimum only when the app was faster', () => {
    const slow = page({ now: 2500 })
    slow.advance(0)
    expect(slow.phase()).toBe('play')
  })

  it('opens at once on a click or a key, also while loading, and only once', () => {
    const intro = page()
    intro.skip()
    expect(intro.phase()).toBe('open')
    intro.advance(INTRO_TIMING.minLoadingMs + INTRO_TIMING.playMs + INTRO_TIMING.openMs)
    expect(intro.classes).toEqual(['intro--open'])
    expect(intro.removed()).toBe(true)
  })

  it('is short with reduced motion', () => {
    const intro = page({ reducedMotion: true })
    intro.advance(INTRO_TIMING.minLoadingMs + INTRO_TIMING.reducedPlayMs + INTRO_TIMING.reducedOpenMs)
    expect(intro.phase()).toBe('gone')
  })

  it('does nothing without the intro element (skipped in index.html)', () => {
    const intro = page({ element: null })
    expect(intro.phase()).toBe('gone')
    expect(intro.remembered()).toBe(false)
  })
})
