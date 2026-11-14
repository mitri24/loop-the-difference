// Field catalogues for the sky view, queried from CORS-enabled mirrors.
import type { AladinInstance, Catalog, CatalogOptions } from 'aladin-lite'
import { useCallback, useEffect, useRef, useState } from 'react'

const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/votable'
const MJD_UNIX_EPOCH = 40587
const MJD_J2000 = 51544.5
const GAIA_EPOCH_YR = 2016.0
// Per layer; VizieR cuts in table order, so the queries sort by brightness first.
export const MAX_SOURCES = 500

// Space must become %20: URLSearchParams would write "+", which the services read literally.
const cone = (ra: number, dec: number) => encodeURIComponent(`${ra} ${dec}`)

export const gaiaUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=I/355/gaiadr3&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=${MAX_SOURCES}&-sort=Gmag&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag`

export const wiseUrl = (ra: number, dec: number, rDeg: number) =>
  `${VIZIER}?-source=II/328/allwise&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=${MAX_SOURCES}&-sort=W1mag&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag`

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

/** The known epoch within a day of the frame, else the frame's own date as a new epoch. */
export const snapEpoch = (known: number[], mjd: number) =>
  known.find((epoch) => Math.abs(epoch - mjd) <= 1) ?? mjd

export interface GaiaRow {
  ra: number
  dec: number
  pmRa: number
  pmDec: number
}

/** Moves a Gaia DR3 position (J2016.0, proper motion in mas/yr, pmRA = μα*) to the frame's epoch. */
export function propagateGaia(row: GaiaRow, mjd: number, refEpochYr = GAIA_EPOCH_YR) {
  const dt = 2000 + (mjd - MJD_J2000) / 365.25 - refEpochYr
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

export type LayerKey = 'gaia' | 'wise' | 'simbad' | 'skybot'
export type LayerStatus = 'off' | 'loading' | 'ready' | 'unavailable'
export interface View {
  ra: number
  dec: number
  r: number
}

// Stable names: a refreshed catalogue replaces the old one under the same name in the layer box.
const LAYERS: Record<LayerKey, Pick<CatalogOptions, 'name' | 'shape'>> = {
  gaia: { name: 'Gaia DR3', shape: 'circle' },
  wise: { name: 'AllWISE', shape: 'square' },
  simbad: { name: 'SIMBAD', shape: 'triangle' },
  skybot: { name: 'SkyBoT', shape: 'rhomb' },
}
const TIMEOUT_MS = 10_000
const DEBOUNCE_MS = 500

// The Gaia answer does not depend on the epoch: one download per view, moved locally per epoch.
let gaiaAnswer: { url: string; rows: Promise<string[][]> } | null = null
function gaiaRows(url: string) {
  if (gaiaAnswer?.url !== url) {
    const rows = fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return parseVotableRows(await res.text())
    })
    rows.catch(() => {
      if (gaiaAnswer?.rows === rows) gaiaAnswer = null
    })
    gaiaAnswer = { url, rows }
  }
  return gaiaAnswer.rows
}

async function loadCatalog(key: LayerKey, { ra, dec, r }: View, mjd: number): Promise<Catalog> {
  const A = (await import('aladin-lite')).default
  const options: CatalogOptions = {
    ...LAYERS[key],
    color: getComputedStyle(document.documentElement).getPropertyValue(`--cat-${key}`).trim(),
    sourceSize: 10,
    limit: MAX_SOURCES,
    onClick: 'showTable',
  }
  if (key === 'gaia') {
    const catalog = A.catalog(options)
    catalog.addSources(
      gaiaSources(await gaiaRows(gaiaUrl(ra, dec, r)), mjd).map((s) =>
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

/**
 * Catalogues per (view, epoch): each pair is asked for once, failures included, so a blink between
 * epochs switches between loaded catalogues instead of querying again. A new view empties the
 * cache; requests run one at a time and those for an older view are skipped.
 */
export function catalogCache<T>(load: (view: View, epoch: number) => Promise<T | null>) {
  let current: View | null = null
  let tail: Promise<unknown> = Promise.resolve()
  const done = new Map<number, T | null>()
  const pending = new Map<number, Promise<T | null>>()
  const enter = (view: View) => {
    if (view === current) return
    current = view
    done.clear()
    pending.clear()
  }
  return {
    /** The loaded catalogue, null after a failure, undefined while unknown. */
    peek(view: View, epoch: number) {
      enter(view)
      return done.get(epoch)
    },
    load(view: View, epoch: number): Promise<T | null> {
      enter(view)
      if (done.has(epoch)) return Promise.resolve(done.get(epoch) ?? null)
      let request = pending.get(epoch)
      if (!request) {
        request = tail.then(async () => {
          if (view !== current) return null
          const catalog = await load(view, epoch)
          if (view === current) {
            pending.delete(epoch)
            done.set(epoch, catalog)
          }
          return catalog
        })
        pending.set(epoch, request)
        tail = request
      }
      return request
    },
  }
}

async function loadWithRetry(key: LayerKey, view: View, epoch: number) {
  return loadCatalog(key, view, epoch)
    .catch(() => loadCatalog(key, view, epoch))
    .catch(() => null)
}

function useLayer(
  key: LayerKey,
  aladin: AladinInstance | null,
  on: boolean,
  view: View | null,
  mjd: number | null,
  report: (key: LayerKey, status: LayerStatus) => void,
) {
  const shown = useRef<Catalog | null>(null)
  const [cache] = useState(() =>
    catalogCache((v: View, epoch: number) => loadWithRetry(key, v, epoch)),
  )
  const epoch = key === 'gaia' || key === 'skybot' ? mjd : 0
  useEffect(() => {
    if (!aladin) return
    const show = (catalog: Catalog | null) => {
      if (shown.current === catalog) return
      if (shown.current) aladin.removeOverlay(shown.current)
      if (catalog) aladin.addCatalog(catalog)
      shown.current = catalog
    }
    if (!on || !view || epoch == null) {
      show(null)
      return
    }
    const settle = (catalog: Catalog | null) => {
      show(catalog)
      report(key, catalog ? 'ready' : 'unavailable')
    }
    const hit = cache.peek(view, epoch)
    if (hit !== undefined) {
      settle(hit)
      return
    }
    let stale = false
    report(key, 'loading')
    void cache.load(view, epoch).then((catalog) => {
      if (!stale) settle(catalog)
    })
    return () => {
      stale = true
    }
  }, [key, aladin, on, view, epoch, report, cache])
}

/**
 * Catalogue overlays around the current Aladin view. Gaia and SkyBoT follow the shown frame's
 * epoch; frames within a day of each other share one epoch.
 */
export function useCatalogLayers(
  aladin: AladinInstance | null,
  enabled: Record<LayerKey, boolean>,
  sizeDeg: number,
  frameMjd: number | null,
) {
  const [view, setView] = useState<View | null>(null)
  const [epochs, setEpochs] = useState<number[]>([])
  const [status, setStatus] = useState<Record<LayerKey, LayerStatus>>({
    gaia: 'off',
    wise: 'off',
    simbad: 'off',
    skybot: 'off',
  })
  const size = useRef(sizeDeg)
  const epoch = frameMjd == null ? null : snapEpoch(epochs, frameMjd)
  if (epoch != null && !epochs.includes(epoch)) setEpochs([...epochs, epoch])

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
