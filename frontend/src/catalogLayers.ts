// Field catalogues for the sky view, queried from CORS-enabled mirrors.
import type { AladinInstance, Catalog, CatalogOptions } from 'aladin-lite'
import { useCallback, useEffect, useRef, useState } from 'react'

// Second mirror for timeouts and "database not reachable" answers; same query syntax, CORS *.
export const VIZIER_MIRRORS = ['https://vizier.cfa.harvard.edu', 'https://vizier.idia.ac.za']
const MJD_UNIX_EPOCH = 40587
const MJD_J2000 = 51544.5
const GAIA_EPOCH_YR = 2016.0
// Per layer; VizieR cuts in table order, so the queries sort by brightness first.
export const MAX_SOURCES = 500
// Gaia (sorted by magnitude) and SIMBAD get slow beyond this radius around the view centre.
export const NEAR_DEG = 0.6

// Space must become %20: URLSearchParams would write "+", which the services read literally.
const cone = (ra: number, dec: number) => encodeURIComponent(`${ra} ${dec}`)

export const gaiaUrl = (ra: number, dec: number, rDeg: number, mirror = VIZIER_MIRRORS[0]) =>
  `${mirror}/viz-bin/votable?-source=I/355/gaiadr3&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=${MAX_SOURCES}&-sort=Gmag&-out=Source,RA_ICRS,DE_ICRS,Plx,pmRA,pmDE,Gmag`

export const wiseUrl = (ra: number, dec: number, rDeg: number, mirror = VIZIER_MIRRORS[0]) =>
  `${mirror}/viz-bin/votable?-source=II/328/allwise&-c=${cone(ra, dec)}&-c.rd=${rDeg}&-out.max=${MAX_SOURCES}&-sort=W1mag&-out=AllWISE,RAJ2000,DEJ2000,W1mag,W2mag`

// TAP always answers with a table, also for an empty field; votable/td keeps the rows readable.
// Brightest first: by V, then Gaia G where V is missing. The service speaks ADQL 2.0 (no NULLS LAST,
// no COALESCE); its PostgreSQL sorts objects without a magnitude last.
export const simbadUrl = (ra: number, dec: number, rDeg: number) =>
  `https://simbad.cfa.harvard.edu/simbad/sim-tap/sync?request=doQuery&lang=adql&format=votable/td&query=${encodeURIComponent(
    `SELECT TOP ${MAX_SOURCES} main_id, ra, dec, otype, pmra, pmdec FROM basic LEFT JOIN allfluxes ON basic.oid = allfluxes.oidref WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, ${rDeg})) = 1 ORDER BY V, G`,
  )}`

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

/**
 * Rows of a VOTable TABLEDATA block (tags may carry a namespace prefix, as SkyBoT's do), cells in
 * FIELD order. Throws on an error answer; SkyBoT's "no object found" error is an empty field.
 */
export function parseVotableRows(xml: string): string[][] {
  if (/No solar system object was found/.test(xml)) return []
  if (!/<(\w+:)?VOTABLE/i.test(xml) || /name="QUERY_STATUS"\s+value="ERROR"/i.test(xml)) {
    throw new Error('not a VOTable')
  }
  return xml
    .split(/<(?:\w+:)?TR>/i)
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<(?:\w+:)?TD\s*\/>|<(?:\w+:)?TD>([^<]*)<\/(?:\w+:)?TD>/gi)].map((m) =>
        (m[1] ?? '').trim(),
      ),
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

/** SIMBAD rows (columns as in simbadUrl) moved from J2000 to the frame epoch; no proper motion → J2000. */
export function simbadSources(rows: string[][], mjd: number) {
  return rows
    .filter(([, ra, dec]) => ra !== '' && dec !== '')
    .map(([name, ra, dec, otype, pmRa, pmDec]) => {
      const pos = propagateGaia(
        { ra: +ra, dec: +dec, pmRa: Number(pmRa) || 0, pmDec: Number(pmDec) || 0 },
        mjd,
        2000,
      )
      const data = {
        main_id: name,
        ra: pos.ra.toFixed(6),
        dec: pos.dec.toFixed(6),
        otype,
        pmra: pmRa,
        pmdec: pmDec,
      }
      return { ...pos, data }
    })
    .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec))
}

/** The name column of a marker: SIMBAD, SkyBoT, AllWISE, Gaia DR3, then our own layers. */
export const sourceName = (data: Record<string, string> = {}) =>
  data.main_id || data.Name || data.AllWISE || data.Source || data.label || ''

export type LayerKey = 'gaia' | 'wise' | 'simbad' | 'skybot'

// A loaded marker as plain data, for drawing it on the SPHEREx images as well (BlinkPlayer).
export interface SkyMark {
  ra: number
  dec: number
  name: string
}
export const NO_MARKS: Record<LayerKey, SkyMark[]> = { gaia: [], wise: [], simbad: [], skybot: [] }
const toMarks = (sources: unknown[]): SkyMark[] => sources.map((source) => {
  const s = source as { ra: number; dec: number; data?: Record<string, string> }
  return { ra: s.ra, dec: s.dec, name: sourceName(s.data) }
})
export type LayerStatus = 'off' | 'loading' | 'ready' | 'none' | 'unavailable'
/** A loaded catalogue, 'none' for a field without objects, null when the service failed. */
export type LayerResult<T> = T | 'none' | null

export const layerStatus = (result: LayerResult<unknown>): LayerStatus =>
  result === 'none' ? 'none' : result ? 'ready' : 'unavailable'
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
// Measured: Gaia sorted at 0.6° up to 8 s, SkyBoT in ecliptic fields up to 15 s.
const TIMEOUT_MS: Record<LayerKey, number> = {
  gaia: 25_000,
  wise: 10_000,
  simbad: 10_000,
  skybot: 25_000,
}
// A failed epoch empties the layer but keeps it, so the open table of another marker stays.
const NO_SOURCES: unknown[] = []
const DEBOUNCE_MS = 500

/**
 * The answer of the first URL that works, as VOTable text and rows. One request at a time: an
 * attempt is aborted when its time is up, before the next one starts; `cancel` stops them all.
 */
export async function fetchVotable(urls: string[], timeoutMs: number, cancel?: AbortSignal) {
  for (const [i, url] of urls.entries()) {
    cancel?.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      return { xml, rows: parseVotableRows(xml) }
    } catch (error) {
      if (i === urls.length - 1) throw error
    }
  }
  throw new Error('no URL')
}

/** VizieR catalogues try the second mirror; the other services are asked twice. */
function attempts(key: LayerKey, { ra, dec, r }: View, mjd: number) {
  const near = Math.min(r, NEAR_DEG)
  if (key === 'gaia') return VIZIER_MIRRORS.map((mirror) => gaiaUrl(ra, dec, near, mirror))
  if (key === 'wise') return VIZIER_MIRRORS.map((mirror) => wiseUrl(ra, dec, r, mirror))
  const url = key === 'simbad' ? simbadUrl(ra, dec, near) : skybotUrl(ra, dec, r, mjd)
  return [url, url]
}

// Gaia and SIMBAD answers do not depend on the epoch: one download per view, moved locally per epoch.
const answers: Partial<Record<LayerKey, { url: string; rows: Promise<string[][]> }>> = {}
function viewRows(key: LayerKey, urls: string[], cancel: AbortSignal) {
  const url = urls[0]
  let answer = answers[key]
  if (answer?.url !== url) {
    const rows = fetchVotable(urls, TIMEOUT_MS[key], cancel).then((a) => a.rows)
    rows.catch(() => {
      if (answers[key]?.rows === rows) delete answers[key]
    })
    answer = answers[key] = { url, rows }
  }
  return answer.rows
}

const catalogOptions = (key: LayerKey): CatalogOptions => ({
  ...LAYERS[key],
  color: getComputedStyle(document.documentElement).getPropertyValue(`--cat-${key}`).trim(),
  sourceSize: 10,
  limit: MAX_SOURCES,
  onClick: 'showTable',
})

async function loadSources(
  key: LayerKey,
  view: View,
  mjd: number,
  cancel: AbortSignal,
): Promise<unknown[] | 'none'> {
  const urls = attempts(key, view, mjd)
  if (key === 'gaia' || key === 'simbad') {
    const rows = await viewRows(key, urls, cancel)
    const sources = key === 'gaia' ? gaiaSources(rows, mjd) : simbadSources(rows, mjd)
    if (sources.length === 0) return 'none'
    const A = (await import('aladin-lite')).default
    return sources.map((s) => A.source(s.ra, s.dec, s.data))
  }
  const { xml, rows } = await fetchVotable(urls, TIMEOUT_MS[key], cancel)
  if (rows.length === 0) return 'none'
  // Aladin parses the answer already downloaded, so a slow service is never asked twice at once.
  const A = (await import('aladin-lite')).default
  const blobUrl = URL.createObjectURL(new Blob([xml], { type: 'text/xml' }))
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(), TIMEOUT_MS[key])
    const done = (catalog?: Catalog) => {
      window.clearTimeout(timer)
      URL.revokeObjectURL(blobUrl)
      if (catalog) resolve(catalog.getSources())
      else reject(new Error('failed'))
    }
    A.catalogFromURL(blobUrl, catalogOptions(key), done, () => done(), false)
  })
}

/**
 * Sources per (view, epoch): each pair is asked for once, failures included, so a blink between
 * epochs switches between loaded catalogues instead of querying again. A new view empties the
 * cache; requests run one at a time, a running one for an older view is aborted and queued ones
 * are skipped.
 */
export function catalogCache<T>(
  load: (view: View, epoch: number, cancel: AbortSignal) => Promise<T | null>,
) {
  let current: View | null = null
  let tail: Promise<unknown> = Promise.resolve()
  let cancel = new AbortController()
  const done = new Map<number, T | null>()
  const pending = new Map<number, Promise<T | null>>()
  const enter = (view: View) => {
    if (view === current) return
    current = view
    cancel.abort()
    cancel = new AbortController()
    done.clear()
    pending.clear()
  }
  return {
    /** The loaded sources, null after a failure, undefined while unknown. */
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
          const catalog = await load(view, epoch, cancel.signal)
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

function useLayer(
  key: LayerKey,
  aladin: AladinInstance | null,
  on: boolean,
  view: View | null,
  mjd: number | null,
  report: (key: LayerKey, status: LayerStatus) => void,
  reportMarks: (key: LayerKey, marks: SkyMark[]) => void,
) {
  // One catalogue per layer, refilled in place: removing it would close Aladin's shared table.
  const catalog = useRef<Promise<Catalog> | null>(null)
  const added = useRef(false)
  const shown = useRef<unknown[] | null>(null)
  const [cache] = useState(() =>
    catalogCache((v: View, epoch: number, cancel: AbortSignal) =>
      loadSources(key, v, epoch, cancel).catch(() => null),
    ),
  )
  // SIMBAD without frames stays at J2000.
  const epoch = key === 'wise' ? 0 : key === 'simbad' ? (mjd ?? MJD_J2000) : mjd
  useEffect(() => {
    if (!aladin) return
    const show = (sources: unknown[] | null) => {
      if (shown.current === sources) return
      shown.current = sources
      catalog.current ??= import('aladin-lite').then(({ default: A }) =>
        A.catalog(catalogOptions(key)),
      )
      void catalog.current.then((c) => {
        if (!sources) {
          if (added.current) aladin.removeOverlay(c)
          added.current = false
          return
        }
        c.clear()
        c.addSources(sources)
        if (!added.current) aladin.addCatalog(c)
        added.current = true
      })
    }
    if (!on || !view || epoch == null) {
      show(null)
      reportMarks(key, [])
      return
    }
    const settle = (result: LayerResult<unknown[]>) => {
      const sources = result === 'none' || !result ? NO_SOURCES : result
      show(sources)
      reportMarks(key, toMarks(sources))
      report(key, layerStatus(result))
    }
    const hit = cache.peek(view, epoch)
    if (hit !== undefined) {
      settle(hit)
      return
    }
    let stale = false
    report(key, 'loading')
    void cache.load(view, epoch).then((sources) => {
      if (!stale) settle(sources)
    })
    return () => {
      stale = true
    }
  }, [key, aladin, on, view, epoch, report, reportMarks, cache])
}

/**
 * Catalogue overlays around the current Aladin view. Gaia, SIMBAD and SkyBoT follow the shown
 * frame's epoch; frames within a day of each other share one epoch.
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
    // Aladin keeps one callback per event and a new one replaces it; old ones are silenced anyway.
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
    // Aladin only highlights a hovered marker; the browser tooltip names it. Aladin reports newly
    // hovered markers before the ones left, so overlapping markers are tracked as a set.
    const hovered = new Set<{ data?: Record<string, string> }>()
    const name = () => {
      if (alive) aladin.aladinDiv.title = sourceName([...hovered].at(-1)?.data)
    }
    aladin.on('objectHovered', (source) => {
      hovered.add(source)
      name()
    })
    aladin.on('objectHoveredStop', (source) => {
      hovered.delete(source)
      name()
    })
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
  // The markers each layer shows, for the SPHEREx images too.
  const [marks, setMarks] = useState<Record<LayerKey, SkyMark[]>>(NO_MARKS)
  const reportMarks = useCallback(
    (key: LayerKey, list: SkyMark[]) => setMarks((old) => (old[key] === list || (old[key].length === 0 && list.length === 0) ? old : { ...old, [key]: list })),
    [],
  )
  useLayer('gaia', aladin, enabled.gaia, view, epoch, report, reportMarks)
  useLayer('wise', aladin, enabled.wise, view, epoch, report, reportMarks)
  useLayer('simbad', aladin, enabled.simbad, view, epoch, report, reportMarks)
  useLayer('skybot', aladin, enabled.skybot, view, epoch, report, reportMarks)

  const shownStatus = (key: LayerKey): LayerStatus => (enabled[key] ? status[key] : 'off')
  return {
    status: {
      gaia: shownStatus('gaia'),
      wise: shownStatus('wise'),
      simbad: shownStatus('simbad'),
      skybot: shownStatus('skybot'),
    },
    skybotDate: epoch == null ? null : isoDate(epoch),
    marks,
  }
}
