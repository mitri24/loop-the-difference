// The target lives in the URL, so every view can be shared or embedded:
// /?ra=08h55m10.831s&dec=-7d14m42.53s&fov=0.2&band=6 (&mode=stacks|difference; default exposures)
// (&name=… when the target was found by name)
export const VIEW_MODES = ['exposures', 'stacks', 'difference'] as const
export type ViewMode = (typeof VIEW_MODES)[number]

export interface TargetQuery {
  ra: string
  dec: string
  fov: number
  band: number
  mode: ViewMode
  name?: string
}

export const POLARIS: TargetQuery = {
  ra: '02:31:49.09',
  dec: '+89:15:50.8',
  fov: 0.2,
  band: 6,
  mode: 'exposures',
}

export function readQuery(search: string): TargetQuery | null {
  const params = new URLSearchParams(search)
  // A "+" typed into the address bar arrives as a space; trimming keeps the value valid.
  const ra = params.get('ra')?.trim()
  const dec = params.get('dec')?.trim()
  if (!ra || !dec) return null
  const name = params.get('name')?.trim()
  return {
    ra,
    dec,
    fov: numberParam(params.get('fov'), 0.02, 1, POLARIS.fov),
    band: Math.round(numberParam(params.get('band'), 1, 6, POLARIS.band)),
    mode: modeParam(params.get('mode')),
    ...(name ? { name } : {}),
  }
}

// ?embed=1 shows only the player, for other websites.
export function readEmbed(search: string): boolean {
  return new URLSearchParams(search).get('embed') === '1'
}

export function toSearch(query: TargetQuery, embed = false): string {
  const params = new URLSearchParams({
    ra: query.ra,
    dec: query.dec,
    fov: String(query.fov),
    band: String(query.band),
  })
  if (query.mode !== POLARIS.mode) params.set('mode', query.mode)
  if (query.name) params.set('name', query.name)
  if (embed) params.set('embed', '1')
  return `?${params}`
}

function modeParam(raw: string | null): ViewMode {
  return VIEW_MODES.find((mode) => mode === raw) ?? POLARIS.mode
}

function numberParam(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
