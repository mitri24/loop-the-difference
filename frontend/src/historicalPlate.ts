// The 1950 POSS-I plate (STScI Digitized Sky Survey) with the Gaia DR3 position predicted for its date.
import type { AladinInstance, Catalog } from 'aladin-lite'
import { useEffect, useState } from 'react'
import { propagateGaia } from './catalogLayers'
import type { ProperMotion } from './types'

export const PLATE_ARCMIN = 20
// POSS-I covers the sky north of about −30°; DSS answers further south with other surveys.
export const POSS_I_MIN_DEC = -30
const PLATE_LAYER = 'POSS-I plate'
const MARKER_COLOUR = '#ffb454'
const TIMEOUT_MS = 20_000
// Aladin registers an image layer only once every layer added before it has loaded.
const REGISTER_POLL_MS = 200
const REGISTER_WAIT_MS = 120_000
const MJD_UNIX_EPOCH = 40587
let loads = 0

export const dssUrl = (ra: number, dec: number, arcmin = PLATE_ARCMIN, survey = 'poss1_red', format: 'fits' | 'gif' = 'fits') =>
  `https://archive.stsci.edu/cgi-bin/dss_search?v=${survey}&r=${ra}&d=${dec}&e=J2000&h=${arcmin}&w=${arcmin}&f=${format}&c=none&fov=NONE&v3=`

export interface PlateHeader {
  survey: string
  plateId: string
  // YYYY-MM-DD; DSS times can be malformed ('06:75:00'), so only the date is kept.
  date: string
}

/** Survey, plate id and date from the primary FITS header (80-character cards up to END). */
export function plateHeader(bytes: Uint8Array): PlateHeader | null {
  const cards: Record<string, string> = {}
  const text = new TextDecoder('ascii')
  for (let at = 0; at + 80 <= bytes.length; at += 80) {
    const card = text.decode(bytes.subarray(at, at + 80))
    const key = card.slice(0, 8).trim()
    if (key === 'END') break
    if (card[8] === '=') cards[key] = card.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim()
  }
  const date = /^\d{4}-\d{2}-\d{2}/.exec(cards['DATE-OBS'] ?? '')?.[0]
  return date ? { survey: cards.SURVEY ?? 'DSS', plateId: cards.PLATEID ?? '?', date } : null
}

export const dateToMjd = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000 + MJD_UNIX_EPOCH

export const predictedOnPlate = (star: ProperMotion, date: string) =>
  propagateGaia({ ra: star.ra, dec: star.dec, pmRa: star.pmra_mas_yr, pmDec: star.pmdec_mas_yr }, dateToMjd(date), star.ref_epoch)

// Moves the plate just above the base survey, so SPHEREx frames always lie on top of it.
function underFrames(aladin: AladinInstance, name: string) {
  for (let at = aladin.getStackLayers().indexOf(name); at > 1; at--) {
    const stack = [...aladin.getStackLayers()]
    if (stack[at] !== name) return
    aladin.view.swapLayers(stack[at - 1], name)
  }
}

export type PlateState =
  | { status: 'off' | 'loading' | 'failed' | 'south' }
  | { status: 'loaded'; header: PlateHeader }

// Fetches the plate, places it as its own image layer (never a SPHEREx frame layer) and marks the predicted star.
export function usePlateLayer(
  aladin: AladinInstance | null,
  on: boolean,
  // Null while the field of a new target is not known yet.
  centre: { ra: number; dec: number } | null,
  star: ProperMotion | null,
): PlateState {
  const { ra, dec } = centre ?? { ra: NaN, dec: NaN }
  const active = !!aladin && on && !!star && !!centre && dec >= POSS_I_MIN_DEC
  // A result counts only for the request it answers; a new field or star is loading until it has one.
  const key = active ? `${ra},${dec},${star.source_id}` : ''
  const [result, setResult] = useState<{ key: string; state: PlateState } | null>(null)

  useEffect(() => {
    if (!aladin || !star || !key) return
    const setState = (state: PlateState) => setResult({ key, state })
    // Own name per load: a late removal of an earlier load never hits this one.
    const name = `${PLATE_LAYER} ${++loads}`
    const abort = new AbortController()
    let url = ''
    let marker: Catalog | null = null
    let done = false
    // The plate should be on the sky; removal waits until Aladin has registered it.
    let wanted = true
    let registered = false
    const drop = () => {
      wanted = false
      if (registered) aladin.removeImageLayer(name)
    }
    // Covers download and Aladin's decoding; a late answer is dropped.
    const timer = window.setTimeout(() => {
      done = true
      abort.abort()
      drop()
      setState({ status: 'failed' })
    }, TIMEOUT_MS)
    const finish = (state: PlateState) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      setState(state)
    }

    const run = async () => {
      const response = await fetch(dssUrl(ra, dec), { signal: abort.signal })
      if (!response.ok) throw new Error(`DSS ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const header = plateHeader(bytes)
      if (!header) throw new Error('no plate date')
      const { default: A } = await import('aladin-lite')
      if (done) return
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/fits' }))
      const layer = A.image(url, {
        imgFormat: 'fits',
        name,
        successCallback: () => {
          if (done) return
          const at = predictedOnPlate(star, header.date)
          marker = A.catalog({
            name: `Gaia DR3 predicted position on ${header.date}`, shape: 'circle', color: MARKER_COLOUR,
            sourceSize: 14, limit: 1, onClick: 'showTable', displayLabel: true, labelColumn: 'label',
            labelColor: MARKER_COLOUR, labelFont: '12px system-ui, sans-serif',
          })
          marker.addSources([A.source(at.ra, at.dec, {
            label: `Gaia DR3 predicted position on ${header.date}`, gaia_dr3: star.source_id,
            plate: `${header.survey} ${header.plateId}`,
          })])
          aladin.addCatalog(marker)
          finish({ status: 'loaded', header })
        },
        errorCallback: () => finish({ status: 'failed' }),
      })
      aladin.setOverlayImageLayer(layer, name)
      const started = Date.now()
      const poll = window.setInterval(() => {
        if (aladin.getStackLayers().includes(name)) {
          registered = true
          if (wanted) underFrames(aladin, name)
          else aladin.removeImageLayer(name)
        } else if (Date.now() - started < REGISTER_WAIT_MS) return
        window.clearInterval(poll)
      }, REGISTER_POLL_MS)
    }
    run().catch(() => finish({ status: 'failed' }))

    return () => {
      done = true
      abort.abort()
      window.clearTimeout(timer)
      drop()
      if (marker) aladin.removeOverlay(marker)
      if (url) URL.revokeObjectURL(url)
    }
  }, [aladin, key, ra, dec, star])

  if (!aladin || !on || !star) return { status: 'off' }
  if (!centre) return { status: 'loading' }
  if (!active) return { status: 'south' }
  return result?.key === key ? result.state : { status: 'loading' }
}
