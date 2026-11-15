// The intro in index.html (#intro): while the app loads, the logo's orbits run; once the app has rendered, the
// planets blink from an earlier to their present position and the name appears (.intro--play), then the logo opens
// onto the workspace (.intro--open) and the intro is removed. Once per tab (index.html skips it afterwards, when
// embedded and for automated browsers unless ?intro=1); a click or a key opens it at once.

export const INTRO_SEEN_KEY = 'ltd-intro-seen'

export const INTRO_TIMING = {
  // The loading animation shows at least this long after the page started, so a fast load still reads as one.
  minLoadingMs: 700,
  // Orbits close, the planets blink and the name appears (index.html: last animation ends at 1.6 s).
  playMs: 1700,
  openMs: 700,
  // Reduced motion: the finished logo, briefly, then a fade.
  reducedPlayMs: 500,
  reducedOpenMs: 300,
}

export interface IntroEnv {
  element: { classList: { add: (name: string) => void }; remove: () => void } | null
  // Milliseconds since the page started (performance.now()).
  now: number
  reducedMotion: boolean
  schedule: (run: () => void, ms: number) => void
  // Calls `skip` on a click or key; returns how to stop listening.
  listen: (skip: () => void) => () => void
  remember: () => void
}

export type IntroPhase = 'loading' | 'play' | 'open' | 'gone'

/** Plays the intro on `env.element`; returns the current phase for tests. */
export function runIntro(env: IntroEnv): () => IntroPhase {
  const { element } = env
  let phase: IntroPhase = element ? 'loading' : 'gone'
  if (!element) return () => phase
  env.remember()
  const play = env.reducedMotion ? INTRO_TIMING.reducedPlayMs : INTRO_TIMING.playMs
  const openMs = env.reducedMotion ? INTRO_TIMING.reducedOpenMs : INTRO_TIMING.openMs
  let stop = () => {}
  const open = () => {
    if (phase === 'open' || phase === 'gone') return
    phase = 'open'
    element.classList.add('intro--open')
    stop()
    env.schedule(() => {
      phase = 'gone'
      element.remove()
    }, openMs)
  }
  stop = env.listen(open)
  env.schedule(() => {
    if (phase !== 'loading') return
    phase = 'play'
    element.classList.add('intro--play')
    env.schedule(open, play)
  }, Math.max(0, INTRO_TIMING.minLoadingMs - env.now))
  return () => phase
}

/** The browser's intro, after the app's first render (main.tsx). */
export function openIntro() {
  const element = document.getElementById('intro')
  if (!element) return
  if (document.documentElement.classList.contains('intro-off')) {
    element.remove()
    return
  }
  runIntro({
    element,
    now: performance.now(),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    schedule: (run, ms) => void window.setTimeout(run, ms),
    listen: (skip) => {
      element.addEventListener('click', skip)
      window.addEventListener('keydown', skip)
      return () => {
        element.removeEventListener('click', skip)
        window.removeEventListener('keydown', skip)
      }
    },
    remember: () => {
      try {
        sessionStorage.setItem(INTRO_SEEN_KEY, '1')
      } catch {
        // Without storage the intro plays again on the next load; nothing breaks.
      }
    },
  })
}
