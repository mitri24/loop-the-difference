import { useId } from 'react'
import { Skeleton } from './Skeleton'
import {
  BLANK_SLICES,
  CHANNELS_PER_BAND,
  CUBE_DEPTH,
  sliceText,
  useCubeWavelengths,
} from '../skyCube'

const BANDS = [1, 2, 3, 4, 5, 6]
// Grid columns of the scale under the slider: one column per slice.
const columns = (first: number, count: number) => ({ gridColumn: `${first + 1} / span ${count}` })

// Picks the background slice of the SPHEREx DR1 all-sky cube (0-based, as Aladin counts).
// `active` is false while another survey is the base layer: the slider would do nothing then.
export function SkySlider({
  value,
  onChange,
  active = true,
}: {
  value: number
  onChange: (slice: number) => void
  active?: boolean
}) {
  const id = useId()
  const { status, wavelengths } = useCubeWavelengths()
  const text = sliceText(value, wavelengths)

  return (
    <div className="sky-slider">
      <label htmlFor={id}>Background channel</label>
      <input
        id={id}
        type="range"
        min={0}
        max={CUBE_DEPTH - 1}
        step={1}
        value={value}
        disabled={!active}
        aria-valuetext={text}
        aria-describedby={`${id}-note`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="sky-slider-scale" aria-hidden="true">
        {BANDS.map((band) => (
          <span key={band} style={columns((band - 1) * CHANNELS_PER_BAND, CHANNELS_PER_BAND)}>
            D{band}
          </span>
        ))}
        <i style={columns(BLANK_SLICES[0], BLANK_SLICES.length)}>×</i>
      </div>
      <output htmlFor={id}>{text}</output>
      {status === 'loading' && <div aria-busy="true"><p className="sr-only">Reading channel wavelengths from IRSA…</p><Skeleton variant="line" /></div>}
      {status === 'unavailable' && (
        <p className="notice">
          IRSA&apos;s cube metadata did not load, so the channel wavelengths are unknown.
        </p>
      )}
      {!active && (
        <p className="notice">
          The background is not the SPHEREx DR1 cube. Choose SPHEREx DR1 all-sky in the Aladin
          layer menu to pick a channel.
        </p>
      )}
      <p className="viz-note" id={`${id}-note`}>
        Context only: the SPHEREx DR1 all-sky mosaic (IRSA HiPS), not the frames being compared. ×
        channels {BLANK_SLICES.map((s) => s + 1).join('–')} are blank (dichroic gap).
      </p>
    </div>
  )
}
