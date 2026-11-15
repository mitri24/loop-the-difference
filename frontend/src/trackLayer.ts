// The possible track on the sky: a dashed line through the predicted positions and a dashed 2σ
// circle at each frame date. The marks themselves are the ◎ layer of candidate.ts.
import type { AladinInstance, Catalog, GraphicOverlay } from 'aladin-lite'
import { useEffect } from 'react'
import { isoDate } from './catalogLayers'
import { SEARCH_AREA_LABEL, num, searchRadius, type Prediction } from './track'
import type { DistanceHypothesis, DistantTrack } from './types'

export const POSSIBLE_TRACK_LABEL = 'possible track – straight-line prediction (2σ, at least 1.5 pixels)'

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

// The distant-object track on the sky: per other image a dotted line through the positions for all assumed
// distances and search circles at a few of them; the circles of one image carry the distances as labels.
const LABELLED_AU = [20, 40, 100, 2000]

// Positions are close to linear in 1/d, the API's grid too.
const nearestHypothesis = (hypotheses: DistanceHypothesis[], au: number) =>
  hypotheses.reduce((best, h, i) =>
    Math.abs(1 / h.distance_au - 1 / au) < Math.abs(1 / hypotheses[best].distance_au - 1 / au) ? i : best, 0)

/**
 * One line per target time through all distances, 20 AU first; circles near 20, 40, 100 and 2000 AU as wide as
 * the search radius the check counts with; labels only on the image at `labelMjd`.
 */
export function distantTrackShapes(track: DistantTrack, labelMjd: number | null, pixelScaleArcsec: number) {
  const { hypotheses } = track
  const times = hypotheses[0]?.points.map((p) => p.mjd) ?? []
  const picks = [...new Set(LABELLED_AU.map((au) => nearestHypothesis(hypotheses, au)))].sort((a, b) => a - b)
  const circles = times.flatMap((_, j) => picks.map((i) => {
    const point = hypotheses[i].points[j]
    return { ...point, radius_arcsec: searchRadius(point.radius_arcsec, pixelScaleArcsec), distance_au: hypotheses[i].distance_au }
  }))
  return {
    lines: times.map((_, j) => hypotheses.map((h): [number, number] => [h.points[j].ra, h.points[j].dec])),
    circles,
    labels: labelMjd == null ? [] : circles
      .filter((c) => Math.abs(c.mjd - labelMjd) < 1e-6)
      .map((c) => ({ ...c, label: `${num(c.distance_au, 2)} AU` })),
  }
}

export function useDistantTrackLayer(aladin: AladinInstance | null, track: DistantTrack | null, labelMjd: number | null, pixelScaleArcsec: number) {
  useEffect(() => {
    if (!aladin || !track || track.hypotheses.length === 0) return
    const { lines, circles, labels } = distantTrackShapes(track, labelMjd, pixelScaleArcsec)
    let overlay: GraphicOverlay | null = null
    let catalog: Catalog | null = null
    let disposed = false
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const color = getComputedStyle(document.documentElement).getPropertyValue('--possible-track').trim()
      overlay = A.graphicOverlay({ name: 'Distant-object track, search circles 2σ (at least 1.5 pixels)', color, lineWidth: 1, lineDash: [2, 4] })
      aladin.addOverlay(overlay)
      for (const line of lines) overlay.add(A.polyline(line))
      for (const c of circles) overlay.add(A.circle(c.ra, c.dec, c.radius_arcsec / 3600))
      if (labels.length === 0) return
      catalog = A.catalog({
        name: 'Distant-object track: assumed distances', shape: 'circle', color, sourceSize: 6, limit: labels.length,
        onClick: 'showTable', displayLabel: true, labelColumn: 'label', labelColor: color, labelFont: '12px system-ui, sans-serif',
      })
      catalog.addSources(labels.map((c) => A.source(c.ra, c.dec, {
        label: c.label, date: isoDate(c.mjd), 'search radius (″)': c.radius_arcsec.toFixed(1), model: track.model,
      })))
      aladin.addCatalog(catalog)
    })
    return () => {
      disposed = true
      if (overlay) aladin.removeOverlay(overlay)
      if (catalog) aladin.removeOverlay(catalog)
    }
  }, [aladin, track, labelMjd, pixelScaleArcsec])
}
