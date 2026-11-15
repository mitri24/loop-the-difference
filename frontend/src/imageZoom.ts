// Zoom and pan inside the SPHEREx image (not the Aladin map): the view is a zoom factor and the point of the image,
// as fractions from its top left corner, that sits in the middle of the viewport. Pure functions, so the player,
// the keyboard and the tests share one rule.

// 8× shows single SPHEREx pixels (6.15″) as blocks of about 40 screen pixels on a 300 px viewport: enough to see a
// star move by one pixel between visits.
export const MAX_ZOOM = 8
// One wheel notch, one button press or one key press.
export const ZOOM_STEP = 1.5
// Shift + an arrow key moves the view by this share of what is visible.
export const PAN_STEP = 0.2

export interface ImageView {
  z: number
  cx: number
  cy: number
}

export const FIT: ImageView = { z: 1, cx: 0.5, cy: 0.5 }

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

/** Zoom between 1× and MAX_ZOOM, and a centre that keeps the image filling the viewport. */
export function clampView(view: ImageView): ImageView {
  const z = clamp(view.z, 1, MAX_ZOOM)
  const half = 0.5 / z
  return { z, cx: clamp(view.cx, half, 1 - half), cy: clamp(view.cy, half, 1 - half) }
}

/**
 * Zoom by `factor` around the viewport point (px, py), as fractions of the viewport: the image point under it stays
 * under it (the pointer for the wheel and a pinch, the middle for buttons and keys).
 */
export function zoomAt(view: ImageView, factor: number, px = 0.5, py = 0.5): ImageView {
  const z = clamp(view.z * factor, 1, MAX_ZOOM)
  const ux = view.cx + (px - 0.5) / view.z
  const uy = view.cy + (py - 0.5) / view.z
  return clampView({ z, cx: ux - (px - 0.5) / z, cy: uy - (py - 0.5) / z })
}

/** Moves the image by (dx, dy) viewport fractions, as a drag does: the image follows the pointer. */
export const panBy = (view: ImageView, dx: number, dy: number): ImageView =>
  clampView({ ...view, cx: view.cx - dx / view.z, cy: view.cy - dy / view.z })

/**
 * CSS for the zoomed layer (transform origin at its top left corner) and for children that must keep the viewport's
 * box (a loading placeholder, an error message): `unzoom` undoes `transform`.
 */
export function viewTransform(view: ImageView): { transform: string; unzoom: string } {
  const x = (0.5 - view.cx * view.z) * 100
  const y = (0.5 - view.cy * view.z) * 100
  const n = (value: number) => Number(value.toFixed(4))
  return {
    transform: `translate(${n(x)}%, ${n(y)}%) scale(${n(view.z)})`,
    unzoom: `scale(${n(1 / view.z)}) translate(${n(-x)}%, ${n(-y)}%)`,
  }
}

/** "1×", "1.5×", "8×" */
export const zoomText = (z: number) => `${Number(z.toFixed(1))}×`
