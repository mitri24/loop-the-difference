// The possible track on the sky: a dashed line through the predicted positions and a dashed 2σ
// circle at each frame date. The marks themselves are the ◎ layer of candidate.ts.
import type { AladinInstance, GraphicOverlay } from 'aladin-lite'
import { useEffect } from 'react'
import { SEARCH_AREA_LABEL, type Prediction } from './track'

export const POSSIBLE_TRACK_LABEL = 'possible track – straight-line prediction (2σ)'

export function useTrackLayer(aladin: AladinInstance | null, predictions: Prediction[]) {
  useEffect(() => {
    if (!aladin || predictions.length === 0) return
    let overlay: GraphicOverlay | null = null
    let disposed = false
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const color = getComputedStyle(document.documentElement).getPropertyValue('--possible-track').trim()
      overlay = A.graphicOverlay({ name: `Possible track, ${SEARCH_AREA_LABEL}`, color, lineWidth: 2, lineDash: [6, 4] })
      aladin.addOverlay(overlay)
      if (predictions.length > 1) overlay.add(A.polyline(predictions.map((p) => [p.ra, p.dec])))
      for (const p of predictions) overlay.add(A.circle(p.ra, p.dec, p.radius_arcsec / 3600))
    })
    return () => {
      disposed = true
      if (overlay) aladin.removeOverlay(overlay)
    }
  }, [aladin, predictions])
}
