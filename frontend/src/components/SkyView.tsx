import type { AladinInstance, GraphicOverlay, HiPSLayer } from 'aladin-lite'
import type AladinModule from 'aladin-lite'
import { useEffect, useRef, useState } from 'react'
import { ALLWISE, SPHEREX, SURVEYS, footprintCorners, sliceForDetector, spherexLabel } from '../sky'

interface Props {
  ra: number
  dec: number
  // Side of the frame in degrees; the view shows CONTEXT_ZOOM times as much sky.
  fov: number
  detector: number
  revision?: number
  onReady?: (aladin: AladinInstance) => void
  onLayerChange?: (label: string) => void
  onUnavailable?: () => void
}

interface Sky {
  A: typeof AladinModule
  aladin: AladinInstance
  spherex: HiPSLayer
  footprint: GraphicOverlay
  spherexReady: boolean
}

const CONTEXT_ZOOM = 4
// If the SPHEREx cube has not arrived by then, the heading says what is really showing.
const SPHEREX_TIMEOUT_MS = 5000
const FALLBACK_LABEL = 'AllWISE (fallback)'

export function SkyView({ ra, dec, fov, detector, revision, onReady, onLayerChange, onUnavailable }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const sky = useRef<Sky | null>(null)
  const latest = useRef({ ra, dec, fov, detector, onReady, onLayerChange, onUnavailable })
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    latest.current = { ra, dec, fov, detector, onReady, onLayerChange, onUnavailable }
  })

  useEffect(() => {
    if (sky.current) place(sky.current, ra, dec, fov)
  }, [ra, dec, fov, revision])

  useEffect(() => {
    if (sky.current) tune(sky.current, detector, onLayerChange)
  }, [detector, onLayerChange])

  useEffect(() => {
    const el = container.current
    if (!el) return
    let cancelled = false
    let timer = 0
    let spherexReady = false
    // Loaded on demand: the engine is large and not needed for the first paint.
    import('aladin-lite')
      .then(async ({ default: A }) => {
        await A.init
        if (cancelled) return
        const start = latest.current
        const aladin = A.aladin(el, {
          survey: A.imageHiPS(ALLWISE.url, { name: ALLWISE.name }),
          hipsList: SURVEYS,
          target: `${start.ra} ${start.dec}`,
          fov: start.fov * CONTEXT_ZOOM,
          realFullscreen: true,
          showReticle: true,
          showCooGridControl: true,
          showSimbadPointerControl: true,
          showSettingsControl: true,
          showShareControl: true,
          showContextMenu: true,
          showProjectionControl: true,
          showLayersControl: true,
          showFullscreenControl: true,
          showStatusBar: true,
        })
        const spherex = A.imageHiPS(SPHEREX.url, {
          name: SPHEREX.name,
          successCallback: (layer) => {
            window.clearTimeout(timer)
            spherexReady = true
            if (sky.current) sky.current.spherexReady = true
            if (!cancelled) {
              layer.setSliceNumber(sliceForDetector(latest.current.detector))
              if (aladin.getBaseImageLayer() === layer) latest.current.onLayerChange?.(spherexLabel(latest.current.detector))
            }
          },
          errorCallback: () => {
            window.clearTimeout(timer)
            if (!cancelled) activateFallback()
          },
        })
        const activateFallback = () => {
          // Never replace a layer the user deliberately selected while loading.
          if (cancelled || aladin.getBaseImageLayer() !== spherex) return
          aladin.setBaseImageLayer(A.imageHiPS(ALLWISE.url, { name: ALLWISE.name }))
          latest.current.onLayerChange?.(FALLBACK_LABEL)
        }
        timer = window.setTimeout(() => { if (!spherexReady) activateFallback() }, SPHEREX_TIMEOUT_MS)
        // Fires when a layer lands or the user picks another survey in the layer box.
        aladin.on('stackChanged', ({ layer }) => {
          if (!layer || cancelled) return
          const base = aladin.getBaseImageLayer()
          latest.current.onLayerChange?.(
            base === spherex ? spherexReady ? spherexLabel(latest.current.detector) : 'SPHEREx survey loading…' : base.name,
          )
        })
        aladin.setBaseImageLayer(spherex)
        aladin.customizeShareURLFunction(() => {
          const url = new URL(window.location.href)
          const [currentRa, currentDec] = aladin.getRaDec()
          url.searchParams.set('ra', currentRa.toFixed(6))
          url.searchParams.set('dec', currentDec.toFixed(6))
          return url.href
        })
        const footprint = A.graphicOverlay({ name: 'Frame footprint', color: '#6ea8fe', lineWidth: 1 })
        aladin.addOverlay(footprint)
        sky.current = { A, aladin, spherex, footprint, spherexReady }
        place(sky.current, start.ra, start.dec, start.fov)
        latest.current.onReady?.(aladin)
      })
      .catch(() => {
        // A.init rejects without WebGL2; the player stays usable.
        if (cancelled) return
        setUnavailable(true)
        latest.current.onUnavailable?.()
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      sky.current = null
      el.replaceChildren()
    }
  }, [])

  if (unavailable) return <p className="notice">The sky view needs WebGL2</p>
  return <div ref={container} className="sky-view" />
}

function place({ A, aladin, footprint }: Sky, ra: number, dec: number, fov: number) {
  aladin.gotoRaDec(ra, dec)
  aladin.setFoV(fov * CONTEXT_ZOOM)
  footprint.removeAll()
  const corners = footprintCorners(ra, dec, fov)
  footprint.add(corners ? A.polygon(corners) : A.circle(ra, dec, fov / 2))
}

// The slice only matters while the SPHEREx cube is the base layer; the user may have picked
// another survey in the layer box.
function tune({ aladin, spherex, spherexReady }: Sky, detector: number, onLayerChange?: (label: string) => void) {
  if (aladin.getBaseImageLayer() !== spherex) return
  spherex.setSliceNumber(sliceForDetector(detector))
  onLayerChange?.(spherexReady ? spherexLabel(detector) : 'SPHEREx survey loading…')
}
