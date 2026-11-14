import type { AladinInstance, GraphicOverlay, HiPSLayer } from 'aladin-lite'
import type AladinModule from 'aladin-lite'
import { useEffect, useRef, useState } from 'react'
import { CatalogLegend } from './CatalogLegend'
import { ALLWISE, SPHEREX, SURVEYS, footprintCorners, sliceForDetector, spherexLabel } from '../sky'

interface Props {
  ra: number
  dec: number
  // Side of the frame in degrees; the view shows CONTEXT_ZOOM times as much sky.
  fov: number
  detector: number
  // Epoch of the shown frame: Gaia stars are moved to it, SkyBoT is asked for it.
  frameMjd?: number | null
  onReady?: (aladin: AladinInstance) => void
  onLayerChange?: (label: string) => void
  onUnavailable?: () => void
}

interface Sky {
  A: typeof AladinModule
  aladin: AladinInstance
  spherex: HiPSLayer
  footprint: GraphicOverlay
}

const CONTEXT_ZOOM = 4
// If the SPHEREx cube has not arrived by then, the heading says what is really showing.
const SPHEREX_TIMEOUT_MS = 5000
const FALLBACK_LABEL = 'AllWISE (fallback)'

export function SkyView({
  ra,
  dec,
  fov,
  detector,
  frameMjd = null,
  onReady,
  onLayerChange,
  onUnavailable,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const sky = useRef<Sky | null>(null)
  const latest = useRef({ ra, dec, fov, detector, onReady, onLayerChange, onUnavailable })
  const [unavailable, setUnavailable] = useState(false)
  const [aladin, setAladin] = useState<AladinInstance | null>(null)

  useEffect(() => {
    latest.current = { ra, dec, fov, detector, onReady, onLayerChange, onUnavailable }
  })

  useEffect(() => {
    if (sky.current) place(sky.current, ra, dec, fov)
  }, [ra, dec, fov])

  useEffect(() => {
    if (sky.current) tune(sky.current, detector, onLayerChange)
  }, [detector, onLayerChange])

  useEffect(() => {
    const el = container.current
    if (!el) return
    let cancelled = false
    let timer = 0
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
            if (!cancelled) layer.setSliceNumber(sliceForDetector(latest.current.detector))
          },
          errorCallback: () => {
            window.clearTimeout(timer)
            if (!cancelled) latest.current.onLayerChange?.(FALLBACK_LABEL)
          },
        })
        timer = window.setTimeout(
          () => latest.current.onLayerChange?.(FALLBACK_LABEL),
          SPHEREX_TIMEOUT_MS,
        )
        // Fires when a layer lands or the user picks another survey in the layer box.
        aladin.on('stackChanged', ({ layer }) => {
          if (!layer || cancelled) return
          const base = aladin.getBaseImageLayer()
          latest.current.onLayerChange?.(
            base === spherex ? spherexLabel(latest.current.detector) : base.name,
          )
        })
        aladin.setBaseImageLayer(spherex)
        aladin.customizeShareURLFunction(() => window.location.href)
        const footprint = A.graphicOverlay({ name: 'Frame footprint', color: '#6ea8fe', lineWidth: 1 })
        aladin.addOverlay(footprint)
        sky.current = { A, aladin, spherex, footprint }
        place(sky.current, start.ra, start.dec, start.fov)
        setAladin(aladin)
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
  return (
    <>
      <CatalogLegend aladin={aladin} ra={ra} dec={dec} sizeDeg={fov} frameMjd={frameMjd} />
      <div ref={container} className="sky-view" />
    </>
  )
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
function tune({ aladin, spherex }: Sky, detector: number, onLayerChange?: (label: string) => void) {
  if (aladin.getBaseImageLayer() !== spherex) return
  spherex.setSliceNumber(sliceForDetector(detector))
  onLayerChange?.(spherexLabel(detector))
}
