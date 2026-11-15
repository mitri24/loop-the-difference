import { skyToFrame } from '../motion'
import type { FrameManifest } from '../types'

export type MarkKind = 'gaia' | 'wise' | 'simbad' | 'skybot' | 'sbident' | 'source-match' | 'source-none' | 'source-unknown'

export interface ImageMark {
  ra: number
  dec: number
  name: string
  kind: MarkKind
}

// Half size in % of the image: about 10 px on a 600 px image.
const R = 1.6

// The same symbols and colours as on the overview map (CatalogLegend, LayersSection, sourceLayer).
function Shape({ kind }: { kind: MarkKind }) {
  switch (kind) {
    case 'gaia':
      return <circle r={R} />
    case 'wise':
      return <rect x={-R} y={-R} width={2 * R} height={2 * R} />
    case 'simbad':
      return <path d={`M0 ${-R * 1.2} L${R * 1.1} ${R * 0.8} L${-R * 1.1} ${R * 0.8} Z`} />
    case 'skybot':
    case 'sbident':
      return <path d={`M0 ${-R * 1.3} L${R * 1.3} 0 L0 ${R * 1.3} L${-R * 1.3} 0 Z`} />
    case 'source-match':
      return <path d={`M${-R} 0 H${R} M0 ${-R} V${R}`} />
    default:
      return <path d={`M${-R} ${-R} L${R} ${R} M${R} ${-R} L${-R} ${R}`} />
  }
}

// What the layers show on the sky, on the SPHEREx image too: every marker projected onto the frame's grid (north up,
// as the Gaia marker), only those inside the image. The hover title names each one.
// zoom: the player's image zoom; the symbols keep their size on screen while their positions zoom with the image.
export function ImageMarks({ marks, grid, zoom = 1 }: { marks: ImageMark[]; grid: Pick<FrameManifest, 'ra' | 'dec' | 'size_deg'>; zoom?: number }) {
  const placed = marks.flatMap((mark) => {
    const at = skyToFrame(mark.ra, mark.dec, grid.ra, grid.dec, grid.size_deg)
    return at ? [{ ...mark, ...at }] : []
  })
  if (placed.length === 0) return null
  return (
    <svg className="image-marks" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {placed.map((mark, i) => (
        <g key={`${mark.kind}-${i}`} className={`image-mark ${mark.kind}`} transform={`translate(${(mark.x * 100).toFixed(2)} ${(mark.y * 100).toFixed(2)})${zoom > 1 ? ` scale(${Number((1 / zoom).toFixed(4))})` : ''}`}>
          <title>{mark.name}</title>
          <Shape kind={mark.kind} />
        </g>
      ))}
    </svg>
  )
}
