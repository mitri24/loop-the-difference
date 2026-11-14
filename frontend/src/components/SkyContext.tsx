import type { AladinView } from 'aladin-lite'
import { useEffect, useRef } from 'react'

interface Props {
  ra: number
  dec: number
  fov: number
}

// Wider view than the frames, so the patch can be seen in its surroundings.
const CONTEXT_ZOOM = 4

export function SkyContext({ ra, dec, fov }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<AladinView | null>(null)
  const latest = useRef({ ra, dec, fov })

  useEffect(() => {
    latest.current = { ra, dec, fov }
    view.current?.gotoRaDec(ra, dec)
    view.current?.setFoV(fov * CONTEXT_ZOOM)
  }, [ra, dec, fov])

  useEffect(() => {
    let cancelled = false
    // Loaded on demand: the engine is large and not needed for the first paint.
    void import('aladin-lite').then(async ({ default: A }) => {
      await A.init
      if (cancelled || !container.current) return
      const start = latest.current
      view.current = A.aladin(container.current, {
        survey: 'P/allWISE/color',
        target: `${start.ra} ${start.dec}`,
        fov: start.fov * CONTEXT_ZOOM,
        showReticle: true,
        showCooGridControl: false,
        showSimbadPointerControl: true,
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  return <div ref={container} className="sky-context" />
}
