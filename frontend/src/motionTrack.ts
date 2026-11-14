// The path a Gaia DR3 star should take across the frames' dates, drawn on the Aladin sky.
import type { AladinInstance, Catalog, GraphicOverlay } from 'aladin-lite'
import { useEffect, useMemo } from 'react'
import { isoDate, propagateGaia } from './catalogLayers'
import { groupEpochs } from './timeAxis'
import type { Frame, ProperMotion } from './types'

export const TRACK_LABEL = 'predicted from Gaia DR3 proper motion'

export interface TrackPoint {
  mjd: number
  ra: number
  dec: number
  // Date of the first frame of each epoch; frames of one epoch sit almost on the same spot.
  label: string
}

// Same linear propagation as motion.ts and match_gaia_csv in backend/app/catalogs.py.
export function trackPoints(star: ProperMotion, mjds: number[]): TrackPoint[] {
  const dates = [...new Set(mjds)].sort((a, b) => a - b)
  const firsts = new Set(groupEpochs(dates).map((e) => e.start))
  return dates.map((mjd) => {
    const { ra, dec } = propagateGaia(
      { ra: star.ra, dec: star.dec, pmRa: star.pmra_mas_yr, pmDec: star.pmdec_mas_yr },
      mjd,
      star.ref_epoch,
    )
    return { mjd, ra: ((ra % 360) + 360) % 360, dec, label: firsts.has(mjd) ? isoDate(mjd) : '' }
  })
}

// Polyline through the predicted positions, a tick per frame date and one date label per epoch.
export function useMotionTrack(
  aladin: AladinInstance | null,
  star: ProperMotion | null | undefined,
  frames: Pick<Frame, 'mjd'>[] | null | undefined,
): TrackPoint[] {
  const key = frames?.map((f) => f.mjd).join(',') ?? ''
  const points = useMemo(
    () => (star && key ? trackPoints(star, key.split(',').map(Number)) : []),
    [star, key],
  )

  useEffect(() => {
    if (!aladin || points.length === 0) return
    let disposed = false
    let line: GraphicOverlay | null = null
    let ticks: Catalog | null = null
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const colour = getComputedStyle(document.documentElement).getPropertyValue('--overlay-track').trim()
      line = A.graphicOverlay({ name: `Track, ${TRACK_LABEL}`, color: colour, lineWidth: 2 })
      aladin.addOverlay(line)
      if (points.length > 1) line.add(A.polyline(points.map((p) => [p.ra, p.dec])))
      ticks = A.catalog({
        name: `Dates, ${TRACK_LABEL}`,
        shape: 'circle',
        color: colour,
        sourceSize: 8,
        limit: points.length,
        onClick: 'showTable',
        displayLabel: true,
        labelColumn: 'label',
        labelColor: colour,
        labelFont: '12px system-ui, sans-serif',
      })
      ticks.addSources(
        points.map((p) =>
          A.source(p.ra, p.dec, {
            label: p.label,
            date: isoDate(p.mjd),
            position: TRACK_LABEL,
            gaia_dr3: star?.source_id ?? '',
          }),
        ),
      )
      aladin.addCatalog(ticks)
    })
    return () => {
      disposed = true
      if (line) aladin.removeOverlay(line)
      if (ticks) aladin.removeOverlay(ticks)
    }
  }, [aladin, points, star])

  return points
}
