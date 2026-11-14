// The region a sky click picked in Explore: a dashed outline of the size "Compare here" asks for.
import type { AladinInstance, GraphicOverlay } from 'aladin-lite'
import { useEffect } from 'react'
import { footprintCorners } from './sky'

export function usePickLayer(aladin: AladinInstance | null, pick: { ra: number; dec: number } | null, sizeDeg: number) {
  useEffect(() => {
    if (!aladin || !pick) return
    let overlay: GraphicOverlay | null = null
    let disposed = false
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const color = getComputedStyle(document.documentElement).getPropertyValue('--overlay-target').trim()
      overlay = A.graphicOverlay({ name: 'Selected region', color, lineWidth: 2, lineDash: [6, 4] })
      aladin.addOverlay(overlay)
      const corners = footprintCorners(pick.ra, pick.dec, sizeDeg)
      overlay.add(corners ? A.polygon(corners) : A.circle(pick.ra, pick.dec, sizeDeg / 2))
    })
    return () => {
      disposed = true
      if (overlay) aladin.removeOverlay(overlay)
    }
  }, [aladin, pick, sizeDeg])
}
