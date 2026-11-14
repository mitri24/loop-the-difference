import type { AladinInstance, ImageLayer } from 'aladin-lite'
import { useEffect, useRef, useState } from 'react'
import type { FrameManifest } from './types'

export const MAX_LAYERS = 12

// Same TAN grid as backend/app/frames.py target_grid(); PNG row 0 is north.
export function gridWcs(
  m: Pick<FrameManifest, 'ra' | 'dec' | 'pixel_scale_arcsec'>,
  width: number,
  height: number,
  flipNorth = false,
) {
  const s = m.pixel_scale_arcsec / 3600
  return {
    NAXIS: 2,
    NAXIS1: width,
    NAXIS2: height,
    CTYPE1: 'RA---TAN',
    CTYPE2: 'DEC--TAN',
    CRVAL1: m.ra,
    CRVAL2: m.dec,
    CRPIX1: (width + 1) / 2,
    CRPIX2: (height + 1) / 2,
    CDELT1: -s,
    CDELT2: flipNorth ? -s : s,
  }
}

export function layerNames(count: number): string[] {
  return Array.from({ length: Math.min(count, MAX_LAYERS) }, (_, i) => `ltd-frame-${String(i).padStart(2, '0')}`)
}

// Real PNG size: a JavaScript re-computation of N would differ from Python's round() at .5.
async function pngSize(url: string) {
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return null // expired job or broken file: show nothing, no retry
  }
}

export type LayerState = 'loaded' | 'failed'

// One image layer per frame (or difference), all loaded once; `index` only switches opacity.
// Returns per index whether its layer reached the sky, so a caption never names a missing frame.
export function useFrameLayers(
  aladin: AladinInstance | null,
  manifest: FrameManifest | null | undefined,
  index: number,
  enabled: boolean,
  kind: 'frames' | 'differences' = 'frames',
): Partial<Record<number, LayerState>> {
  const indexRef = useRef(index)
  const layers = useRef<ImageLayer[]>([])
  // Runs are chained, so an old run's late layers never collide with the same names of a new run.
  const queue = useRef(Promise.resolve())
  const [states, setStates] = useState<{
    manifest: FrameManifest | null | undefined
    byIndex: Partial<Record<number, LayerState>>
  }>({ manifest: null, byIndex: {} })

  useEffect(() => {
    indexRef.current = index
    layers.current.forEach((layer, i) => layer.setOpacity(i === index ? 1 : 0))
  }, [index])

  useEffect(() => {
    if (!aladin || !manifest || !enabled) return
    const urls = manifest[kind].slice(0, MAX_LAYERS).map((item) => item.url)
    const names = layerNames(urls.length)
    const loaded: ImageLayer[] = []
    let disposed = false

    const report = (i: number, state: LayerState) => {
      if (disposed) return
      setStates((old) => ({
        manifest,
        byIndex: { ...(old.manifest === manifest ? old.byIndex : {}), [i]: state },
      }))
    }
    const run = async () => {
      const { default: A } = await import('aladin-lite')
      await Promise.all(
        urls.map(async (url, i) => {
          const size = await pngSize(url)
          if (!size) return report(i, 'failed')
          if (disposed) return
          await new Promise<void>((resolve) => {
            const layer = A.image(url, {
              imgFormat: 'png',
              name: names[i],
              wcs: gridWcs(manifest, size.width, size.height),
              // Aladin turns an initial opacity of 0 into 1, so it is set once the layer exists.
              successCallback: (_ra, _dec, _fov, added) => {
                added.setOpacity(i === indexRef.current ? 1 : 0)
                loaded[i] = added
                report(i, 'loaded')
                resolve()
              },
              errorCallback: () => {
                report(i, 'failed')
                resolve()
              },
            })
            aladin.setOverlayImageLayer(layer, names[i])
          })
        }),
      )
      if (!disposed) return
      // Aladin registers a layer one task after its callback; removing earlier would miss it.
      await new Promise((resolve) => window.setTimeout(resolve))
      names.forEach((name) => aladin.removeImageLayer(name))
    }

    layers.current = loaded
    queue.current = queue.current.then(run).catch(() => undefined)
    return () => {
      disposed = true
      layers.current = []
      names.forEach((name) => aladin.removeImageLayer(name))
    }
  }, [aladin, manifest, enabled, kind])

  return states.manifest === manifest ? states.byIndex : {}
}
