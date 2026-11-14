// Field catalogues for the sky view. Mirrors, CORS and epochs: see NAS-22 "Service status and CORS".
import { useCallback, useEffect, useRef, useState } from 'react'

const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/votable'
const MJD_UNIX_EPOCH = 40587
const MJD_J2000 = 51544.5
const GAIA_EPOCH_YR = 2016.0

// Space must become %20: URLSearchParams would write "+", which the services read literally.
const cone = (ra: number, dec: number) => encodeURIComponent(`${ra} ${dec}`)

export const gaiaUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=I/355/gaiadr3&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=500&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag`

export const wiseUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=II/328/allwise&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=500&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag`

export const simbadUrl = (ra: number, dec: number, rDeg: number) =>
  `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${cone(ra, dec)}&Radius=${rDeg * 60}&Radius.unit=arcmin&output.format=votable`

// Asteroids move: the epoch is the shown frame's time, passed as Julian Date.
export const skybotUrl = (ra: number, dec: number, rDeg: number, mjd: number) =>
  `https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep=${mjd + 2400000.5}&-ra=${ra}&-dec=${dec}&-rd=${rDeg}&-mime=votable&-output=object&-from=LoopTheDifference`

/** Query radius in degrees: a bit wider than the view, never smaller than the frames, at most 1°. */
export const catalogRadius = (fovDeg: number, sizeDeg: number) =>
  Math.min(1, Math.max(0.75 * fovDeg, sizeDeg))

/** Calendar date (UTC, YYYY-MM-DD) of a frame, for the SkyBoT legend. */
export const isoDate = (mjd: number) =>
  new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000).toISOString().slice(0, 10)

export interface GaiaRow {
  ra: number
  dec: number
  pmRa: number
  pmDec: number
}

/** Moves a Gaia DR3 position (J2016.0, proper motion in mas/yr, pmRA = μα*) to the frame's epoch. */
export function propagateGaia(row: GaiaRow, mjd: number) {
  const dt = 2000 + (mjd - MJD_J2000) / 365.25 - GAIA_EPOCH_YR
  const dec = row.dec + (row.pmDec / 3.6e6) * dt
  const ra = row.ra + ((row.pmRa / 3.6e6) * dt) / Math.cos((row.dec * Math.PI) / 180)
  return { ra, dec }
}

/** Rows of a VOTable TABLEDATA block, cells in FIELD order. Throws on an error answer. */
export function parseVotableRows(xml: string): string[][] {
  if (!/<VOTABLE/i.test(xml) || /name="QUERY_STATUS"\s+value="ERROR"/i.test(xml)) {
    throw new Error('not a VOTable')
  }
  return xml
    .split(/<TR>/i)
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<TD\s*\/>|<TD>([^<]*)<\/TD>/gi)].map((m) => (m[1] ?? '').trim()),
    )
}

/** Gaia rows (columns as in gaiaUrl) moved to the frame epoch; no proper motion → J2016.0 position. */
export function gaiaSources(rows: string[][], mjd: number) {
  return rows
    .filter(([, ra, dec]) => ra !== '' && dec !== '')
    .map(([source, ra, dec, plx, pmRa, pmDec, gmag]) => {
      const pos = propagateGaia(
        { ra: +ra, dec: +dec, pmRa: Number(pmRa) || 0, pmDec: Number(pmDec) || 0 },
        mjd,
      )
      const data = {
        Source: source,
        ra: pos.ra.toFixed(6),
        dec: pos.dec.toFixed(6),
        Gmag: gmag,
        Plx: plx,
        pmRA: pmRa,
        pmDE: pmDec,
      }
      return { ...pos, data }
    })
    .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec))
}

// Aladin Lite 3.9 catalogue API as found in the bundle; the package ships no types.
interface Catalog {
  addSources(sources: unknown[]): void
}
interface CatalogOptions {
  name: string
  shape: 'circle' | 'square' | 'triangle' | 'rhomb'
  color: string
  sourceSize: number
  onClick: 'showTable'
}
interface CatalogApi {
  catalog(options: CatalogOptions): Catalog
  source(ra: number, dec: number, data: Record<string, string>): unknown
  catalogFromURL(
    url: string,
    o: CatalogOptions,
    ok: (c: Catalog) => void,
    err: () => void,
    proxy: false,
  ): void
}
export interface CatalogHost {
  getRaDec(): [number, number]
  getFov(): [number, number]
  addCatalog(catalog: Catalog): void
  removeOverlay(catalog: Catalog): void
  on(event: 'positionChanged', callback: () => void): void
  on(event: 'zoomChanged', callback: () => void): void
}

export type LayerKey = 'gaia' | 'wise' | 'simbad' | 'skybot'
export type LayerStatus = 'off' | 'loading' | 'ready' | 'unavailable'
interface View {
  ra: number
  dec: number
  r: number
}

const LAYERS: Record<LayerKey, Pick<CatalogOptions, 'name' | 'shape' | 'color'>> = {
  gaia: { name: 'Gaia DR3', shape: 'circle', color: '#7fd4ff' },
  wise: { name: 'AllWISE', shape: 'square', color: '#ff8a65' },
  simbad: { name: 'SIMBAD', shape: 'triangle', color: '#ffd54f' },
  skybot: { name: 'SkyBoT', shape: 'rhomb', color: '#b39ddb' },
}
const TIMEOUT_MS = 10_000
const DEBOUNCE_MS = 500

async function loadCatalog(key: LayerKey, { ra, dec, r }: View, mjd: number): Promise<Catalog> {
  const A = (await import('aladin-lite')).default as unknown as CatalogApi
  const token = getComputedStyle(document.documentElement).getPropertyValue(`--cat-${key}`).trim()
  const options: CatalogOptions = {
    ...LAYERS[key],
    color: token || LAYERS[key].color,
    sourceSize: 10,
    onClick: 'showTable',
  }
  if (key === 'gaia') {
    const res = await fetch(gaiaUrl(ra, dec, r), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const catalog = A.catalog(options)
    catalog.addSources(
      gaiaSources(parseVotableRows(await res.text()), mjd).map((s) =>
        A.source(s.ra, s.dec, s.data),
      ),
    )
    return catalog
  }
  const url =
    key === 'wise'
      ? wiseUrl(ra, dec, r)
      : key === 'simbad'
        ? simbadUrl(ra, dec, r)
        : skybotUrl(ra, dec, r, mjd)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
    const done = (catalog?: Catalog) => {
      window.clearTimeout(timer)
      if (catalog) resolve(catalog)
      else reject(new Error('failed'))
    }
    A.catalogFromURL(url, options, done, () => done(), false)
  })
}

// One request in flight per layer; a newer view waits and replaces any older queued one.
function useLayer(
  key: LayerKey,
  aladin: CatalogHost | null,
  on: boolean,
  view: View | null,
  mjd: number | null,
  report: (key: LayerKey, status: LayerStatus) => void,
) {
  const shown = useRef<Catalog | null>(null)
  const busy = useRef(false)
  const queued = useRef<(() => void) | null>(null)
  const epoch = key === 'gaia' || key === 'skybot' ? mjd : 0
  useEffect(() => {
    if (!aladin) return
    const drop = () => {
      if (shown.current) aladin.removeOverlay(shown.current)
      shown.current = null
    }
    if (!on || !view || epoch == null) {
      queued.current = null
      drop()
      return
    }
    let stale = false
    const run = async () => {
      busy.current = true
      report(key, 'loading')
      let catalog: Catalog | null = null
      for (let attempt = 0; attempt < 2 && !catalog && !stale; attempt++) {
        catalog = await loadCatalog(key, view, epoch).catch(() => null)
      }
      busy.current = false
      if (!stale) {
        if (catalog) {
          drop()
          aladin.addCatalog(catalog)
          shown.current = catalog
        }
        report(key, catalog ? 'ready' : 'unavailable')
      }
      const next = queued.current
      queued.current = null
      next?.()
    }
    if (busy.current) queued.current = run
    else void run()
    return () => {
      stale = true
    }
  }, [key, aladin, on, view, epoch, report])
}

/**
 * Catalogue overlays around the current Aladin view. Gaia and SkyBoT follow the shown frame's
 * epoch, re-queried only when it moves by more than a day, so blinking does not refetch.
 */
export function useCatalogLayers(
  aladin: CatalogHost | null,
  enabled: Record<LayerKey, boolean>,
  sizeDeg: number,
  frameMjd: number | null,
) {
  const [view, setView] = useState<View | null>(null)
  const [epoch, setEpoch] = useState(frameMjd)
  const [status, setStatus] = useState<Record<LayerKey, LayerStatus>>({
    gaia: 'off',
    wise: 'off',
    simbad: 'off',
    skybot: 'off',
  })
  const size = useRef(sizeDeg)
  if (frameMjd != null && (epoch == null || Math.abs(frameMjd - epoch) > 1)) setEpoch(frameMjd)

  useEffect(() => {
    size.current = sizeDeg
  }, [sizeDeg])

  useEffect(() => {
    if (!aladin) return
    let alive = true
    let timer = 0
    // Aladin has no way to remove a listener, so old ones are silenced instead.
    const read = () => {
      const [ra, dec] = aladin.getRaDec()
      if (alive) setView({ ra, dec, r: catalogRadius(aladin.getFov()[0], size.current) })
    }
    const later = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(read, DEBOUNCE_MS)
    }
    aladin.on('positionChanged', later)
    aladin.on('zoomChanged', later)
    later()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [aladin])

  const report = useCallback(
    (key: LayerKey, s: LayerStatus) => setStatus((old) => ({ ...old, [key]: s })),
    [],
  )
  useLayer('gaia', aladin, enabled.gaia, view, epoch, report)
  useLayer('wise', aladin, enabled.wise, view, epoch, report)
  useLayer('simbad', aladin, enabled.simbad, view, epoch, report)
  useLayer('skybot', aladin, enabled.skybot, view, epoch, report)

  const shownStatus = (key: LayerKey): LayerStatus => (enabled[key] ? status[key] : 'off')
  return {
    status: {
      gaia: shownStatus('gaia'),
      wise: shownStatus('wise'),
      simbad: shownStatus('simbad'),
      skybot: shownStatus('skybot'),
    },
    skybotDate: epoch == null ? null : isoDate(epoch),
  }
}
