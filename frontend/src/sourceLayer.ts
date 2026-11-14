// Sources the backend detected in the SPHEREx frames, drawn on the Aladin sky for the shown frame.
import type { AladinInstance, Catalog, CatalogOptions } from 'aladin-lite'
import type AladinModule from 'aladin-lite'
import { useEffect, useState } from 'react'
import type { DetectedSource, Frame, SourceMatch } from './types'

export const MATCHES: SourceMatch[] = ['gaia', 'allwise', 'none', 'unknown']

// A SPHEREx detection is + with a catalogue match and × without one, so it never looks like a
// catalogue-layer marker (circle, square, triangle, rhomb). The word names the catalogue or says
// why there is none; "unknown" is a muted × (colours: --src-* in styles/tokens.css).
export const MATCH_STYLE: Record<
  SourceMatch,
  { shape: CatalogOptions['shape']; glyph: string; word: string }
> = {
  gaia: { shape: 'plus', glyph: '+', word: 'Gaia DR3 match' },
  allwise: { shape: 'plus', glyph: '+', word: 'AllWISE match' },
  none: { shape: 'cross', glyph: '×', word: 'No catalogue match – needs verification' },
  unknown: { shape: 'cross', glyph: '×', word: 'Unknown – catalogue unavailable' },
}

export type SourceCounts = Record<SourceMatch | 'detected', number>

export function countSources(sources: DetectedSource[]): SourceCounts {
  const counts: SourceCounts = { detected: sources.length, gaia: 0, allwise: 0, none: 0, unknown: 0 }
  for (const source of sources) counts[source.match] += 1
  return counts
}

export const degText = (deg: number) => `${deg.toFixed(5)}°`.replace('-', '−')

/** Highest signal-to-noise first; the manifest's own order stays untouched. */
export const brightestFirst = (sources: DetectedSource[]) =>
  [...sources].sort((a, b) => b.snr - a.snr)

/** "G 13.30" or "W1 9.87": the catalogue magnitude with its band (Vega). */
export const catalogMag = (source: DetectedSource) =>
  source.catalog_mag == null || source.catalog_band == null
    ? null
    : `${source.catalog_band} ${source.catalog_mag.toFixed(2)}`

/** Columns of Aladin's source table: the label, its evidence and the frame it was found in. */
export function sourceRow(source: DetectedSource, frame: Frame): Record<string, string> {
  return {
    label: MATCH_STYLE[source.match].word,
    catalogue: source.catalog_id ?? '–',
    separation:
      source.separation_arcsec == null ? '–' : `${source.separation_arcsec.toFixed(1)} arcsec`,
    magnitude: catalogMag(source) ?? '–',
    snr: source.snr.toFixed(1),
    peak: `${source.peak_mjy_sr} MJy/sr`,
    ra: `${source.ra.toFixed(5)}°`,
    dec: `${source.dec.toFixed(5)}°`,
    obs_id: frame.obs_id,
    date: frame.date,
    detector: `D${frame.detector}`,
  }
}

interface Layer {
  A: typeof AladinModule
  aladin: AladinInstance
  catalogs: Record<SourceMatch, Catalog>
}

/**
 * One Aladin catalogue per label, refilled from the manifest when the blink index changes: the
 * sources travel with the frames, so nothing is fetched.
 */
export function useSourceLayer(
  aladin: AladinInstance | null,
  frames: Frame[] | null | undefined,
  index: number,
  visible: boolean,
) {
  const [layer, setLayer] = useState<Layer | null>(null)

  useEffect(() => {
    if (!aladin || !visible) return
    let disposed = false
    const added: Catalog[] = []
    void import('aladin-lite').then(({ default: A }) => {
      if (disposed) return
      const css = getComputedStyle(document.documentElement)
      const catalog = (match: SourceMatch) => {
        const made = A.catalog({
          name: `SPHEREx sources: ${MATCH_STYLE[match].word}`,
          shape: MATCH_STYLE[match].shape,
          color: css.getPropertyValue(`--src-${match}`).trim(),
          sourceSize: 16,
          limit: Number.MAX_SAFE_INTEGER,
          onClick: 'showTable',
        })
        aladin.addCatalog(made)
        added.push(made)
        return made
      }
      const catalogs = {
        gaia: catalog('gaia'),
        allwise: catalog('allwise'),
        none: catalog('none'),
        unknown: catalog('unknown'),
      }
      setLayer({ A, aladin, catalogs })
    })
    return () => {
      disposed = true
      added.forEach((catalog) => aladin.removeOverlay(catalog))
    }
  }, [aladin, visible])

  const shown = visible && layer?.aladin === aladin ? layer : null
  const frame = frames?.[index]
  useEffect(() => {
    if (!shown) return
    for (const match of MATCHES) {
      const catalog = shown.catalogs[match]
      catalog.removeAll()
      if (!frame) continue
      catalog.addSources(
        (frame.sources ?? [])
          .filter((source) => source.match === match)
          .map((source) => shown.A.source(source.ra, source.dec, sourceRow(source, frame))),
      )
    }
  }, [shown, frame])
}
