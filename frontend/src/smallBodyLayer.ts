// Known asteroids and comets (NASA/JPL SBIdent) as labelled markers at the shown frame's time.
import type { AladinInstance, Catalog, CatalogOptions } from 'aladin-lite'
import { useEffect } from 'react'
import type { SmallBody, SmallBodyEpoch } from './types'

export const SMALL_BODY_LAYER = 'Known asteroids/comets (JPL SBIdent)'
// JPL's rates are linear motion: fine for hours, not for days. Further away no marker is drawn.
export const MAX_GAP_DAYS = 1

export const markerLabel = (name: string) => `known asteroid/comet: ${name}`

/** The answered epoch closest to the frame's time, if it lies within MAX_GAP_DAYS. */
export function epochFor(epochs: SmallBodyEpoch[], mjd: number): SmallBodyEpoch | null {
  let best: SmallBodyEpoch | null = null
  for (const epoch of epochs) {
    const gap = Math.abs(epoch.mjd - mjd)
    if (epoch.error == null && gap <= MAX_GAP_DAYS && (!best || gap < Math.abs(best.mjd - mjd))) {
      best = epoch
    }
  }
  return best
}

/** Position at `mjd`, moved along JPL's rates (arcsec per hour, RA rate on the sky). */
export function positionAt(body: SmallBody, fromMjd: number, mjd: number) {
  const hours = (mjd - fromMjd) * 24
  const ra = body.ra + (body.ra_rate * hours) / 3600 / Math.cos((body.dec * Math.PI) / 180)
  return { ra: ((ra % 360) + 360) % 360, dec: body.dec + (body.dec_rate * hours) / 3600 }
}

/** One marker per body; the table Aladin shows on click keeps name, brightness and source. */
export function smallBodyMarkers(epoch: SmallBodyEpoch, mjd: number) {
  return epoch.bodies.map((body) => ({
    ...positionAt(body, epoch.mjd, mjd),
    data: {
      label: markerLabel(body.name),
      V: body.vmag == null ? 'n/a' : body.vmag.toFixed(1),
      'RA rate (″/h)': body.ra_rate.toFixed(2),
      'Dec rate (″/h)': body.dec_rate.toFixed(2),
      'Looked up for (UTC)': epoch.date,
      Source: 'NASA/JPL SBIdent, geocentric',
    },
  }))
}

/** Markers for the epoch of the shown frame; nothing when no answered epoch lies within a day. */
export function useSmallBodyLayer(
  aladin: AladinInstance | null,
  epochs: SmallBodyEpoch[],
  currentMjd: number | null,
  visible: boolean,
) {
  useEffect(() => {
    if (!aladin || !visible || currentMjd == null) return
    const epoch = epochFor(epochs, currentMjd)
    if (!epoch || epoch.bodies.length === 0) return
    let catalog: Catalog | null = null
    let disposed = false
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue('--cat-sbident')
        .trim()
      const options: CatalogOptions = {
        name: SMALL_BODY_LAYER,
        shape: 'rhomb',
        color,
        sourceSize: 12,
        limit: epoch.bodies.length,
        onClick: 'showTable',
        displayLabel: true,
        labelColumn: 'label',
        labelColor: color,
      }
      catalog = A.catalog(options)
      catalog.addSources(
        smallBodyMarkers(epoch, currentMjd).map((m) => A.source(m.ra, m.dec, m.data)),
      )
      aladin.addCatalog(catalog)
    })
    return () => {
      disposed = true
      if (catalog) aladin.removeOverlay(catalog)
    }
  }, [aladin, epochs, currentMjd, visible])
}
