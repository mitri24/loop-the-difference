// The SPHEREx DR1 all-sky HiPS cube as background: one of its 102 slices, with the wavelength of
// each slice read from IRSA's live cube metadata (data_cube_crval3_arr of the properties file).
import type { AladinInstance } from 'aladin-lite'
import { useEffect, useState } from 'react'
import { SPHEREX } from './sky'

export const CUBE_DEPTH = 102
export const CHANNELS_PER_BAND = 17
// Slices 50 and 51 (band 3 channel 17, band 4 channel 1) are the blank dichroic channels, as the
// cube's properties (obs_description) say. Slices count from 0, as Aladin's setSliceNumber does.
export const BLANK_SLICES = [50, 51]
const PROPERTIES_URL = `${SPHEREX.url}/properties`
const TIMEOUT_MS = 8000

export function parseCubeWavelengths(properties: string): number[] | null {
  const value = (key: string) => properties.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1]
  const depth = Number(value('hips_cube_depth'))
  const um = value('data_cube_crval3_arr')?.trim().split(/\s+/).map(Number)
  if (value('data_cube_bunit3')?.trim() !== 'um' || !um || um.length !== depth) return null
  return um.every(Number.isFinite) ? um : null
}

export const bandOfSlice = (slice: number) => Math.floor(slice / CHANNELS_PER_BAND) + 1
export const isBlankSlice = (slice: number) => BLANK_SLICES.includes(slice)

export function sliceText(slice: number, wavelengths: number[] | null): string {
  const where = `Channel ${slice + 1} of ${CUBE_DEPTH} · D${bandOfSlice(slice)}`
  if (isBlankSlice(slice)) return `${where} · blank (dichroic gap, no data)`
  if (!wavelengths) return `${where} · wavelength unknown`
  return `${where} · ${wavelengths[slice].toFixed(3)} µm`
}

let request: Promise<number[] | null> | null = null
// Asked once per page; after a failure the wavelengths stay unknown and the slider says so.
export function loadCubeWavelengths(): Promise<number[] | null> {
  request ??= fetch(PROPERTIES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then((response) => (response.ok ? response.text() : null))
    .then((text) => (text ? parseCubeWavelengths(text) : null))
    .catch(() => null)
  return request
}

export type CubeStatus = 'loading' | 'ready' | 'unavailable'

export function useCubeWavelengths(): { status: CubeStatus; wavelengths: number[] | null } {
  const [wavelengths, setWavelengths] = useState<number[] | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void loadCubeWavelengths().then((um) => {
      if (alive) setWavelengths(um)
    })
    return () => {
      alive = false
    }
  }, [])
  if (wavelengths === undefined) return { status: 'loading', wavelengths: null }
  return { status: wavelengths ? 'ready' : 'unavailable', wavelengths }
}

// The slice only applies while the SPHEREx cube is the base layer; the user may pick another
// survey in Aladin's layer menu. Returns whether the cube is the base layer.
// Read on every render: Aladin keeps one callback per event and SkyView owns 'stackChanged'; its
// onLayerChange re-renders the caller whenever the base layer changes.
export function useSkySlice(aladin: AladinInstance | null, slice: number): boolean {
  const active = aladin?.getBaseImageLayer()?.name === SPHEREX.name
  useEffect(() => {
    // The base is briefly missing while Aladin swaps in the AllWISE fallback.
    if (aladin && active) aladin.getBaseImageLayer()?.setSliceNumber(slice)
  }, [aladin, active, slice])
  return active
}
