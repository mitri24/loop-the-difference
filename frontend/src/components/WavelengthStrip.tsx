import type { Frame } from '../types'
import { scale } from './SpectrumChart'

// Same ranges as the detector list in targets.ts (SPHEREx DR1 archive metadata), in µm.
export const DETECTOR_RANGES_UM: Record<number, [number, number]> = {
  1: [0.75, 1.12],
  2: [1.1, 1.65],
  3: [1.63, 2.43],
  4: [2.4, 3.85],
  5: [3.81, 4.43],
  6: [4.41, 5.01],
}
export const AXIS_UM: [number, number] = [0.75, 5.0]
const AXIS_TICKS = [1, 2, 3, 4, 5]
// Drawn at the sidebar's width, so 11px text stays 11px.
const W = 320
const BAR = 14
// Odd detectors in the upper row, even ones below: neighbouring ranges overlap slightly.
const ROW_Y = { odd: 30, even: 46 }
const AXIS_Y = 70
const H = 92
const M = { left: 8, right: 16 }

type FrameWavelength = Pick<Frame, 'wavelength_um' | 'bandwidth_um'>

// bandwidth_um is the full width of one resolution element (≈ λ/R), centred on wavelength_um.
export function passband(frame: FrameWavelength | null | undefined): [number, number] | null {
  if (frame?.wavelength_um == null) return null
  const half = (frame.bandwidth_um ?? 0) / 2
  return [frame.wavelength_um - half, frame.wavelength_um + half]
}

export function wavelengthText(frame: FrameWavelength | null | undefined): string {
  if (frame?.wavelength_um == null) return 'wavelength unknown'
  const width = frame.bandwidth_um == null ? '' : `, bandwidth ${frame.bandwidth_um.toFixed(3)} µm`
  return `λ ${frame.wavelength_um.toFixed(3)} µm${width}`
}

export const detectorText = (detector: number) =>
  `D${detector} ${DETECTOR_RANGES_UM[detector].map((um) => um.toFixed(2)).join('–')} µm`

export function WavelengthStrip({
  detector,
  frame,
}: {
  detector?: number
  frame?: FrameWavelength | null
}) {
  const x = scale(AXIS_UM, [M.left, W - M.right])
  const band = passband(frame)
  const centre = frame?.wavelength_um
  const selected = detector && DETECTOR_RANGES_UM[detector] ? detectorText(detector) : null
  const summary =
    'SPHEREx detectors D1 to D6 on a wavelength axis from 0.75 to 5.0 µm' +
    (selected ? `; selected ${selected}` : '') +
    `; current frame ${wavelengthText(frame)}`

  return (
    <figure className="viz wavelength-strip">
      <figcaption className="viz-title">Where the current frame sits in wavelength</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary}>
        {Object.entries(DETECTOR_RANGES_UM).map(([key, [lo, hi]]) => {
          const d = Number(key)
          const y = d % 2 ? ROW_Y.odd : ROW_Y.even
          return (
            <g key={d} className={d === detector ? 'viz-band selected' : 'viz-band'}>
              <rect x={x(lo)} y={y} width={x(hi) - x(lo)} height={BAR} rx={2} />
              <text x={(x(lo) + x(hi)) / 2} y={y + BAR - 3} textAnchor="middle">
                D{d}
              </text>
            </g>
          )
        })}
        {band && centre != null && (
          <g className="viz-marker">
            <rect
              x={x(band[0]) - 1}
              y={ROW_Y.odd - 6}
              width={Math.max(2, x(band[1]) - x(band[0])) + 2}
              height={ROW_Y.even + BAR - ROW_Y.odd + 12}
            />
            <text x={x(centre)} y={ROW_Y.odd - 10} textAnchor="middle">
              ▼ {centre.toFixed(3)} µm
            </text>
          </g>
        )}
        <g className="viz-axis">
          <line x1={M.left} x2={W - M.right} y1={AXIS_Y} y2={AXIS_Y} />
          {AXIS_TICKS.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={AXIS_Y} y2={AXIS_Y + 4} />
              <text x={x(t)} y={AXIS_Y + 17} textAnchor="middle">
                {t === 5 ? '5 µm' : t}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <p className="viz-note">
        {selected && <>Selected detector {selected} (outlined). </>}
        Current frame: {wavelengthText(frame)}
        {band ? ' (▼, width = one resolution element).' : '.'}
      </p>
    </figure>
  )
}
