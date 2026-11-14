// Time rules shared by the evidence charts: epochs as the backend groups them, a padded date
// domain and calendar ticks, all in MJD (UTC).
import { isoDate } from './catalogLayers'

// Same rule as group_epochs in backend/app/archive.py: a gap of more than 30 days starts an epoch.
export const EPOCH_GAP_DAYS = 30
const MJD_UNIX_EPOCH = 40587
const DAY_MS = 86_400_000

export interface EpochSpan {
  start: number
  end: number
  count: number
}

export function groupEpochs(mjds: number[]): EpochSpan[] {
  const epochs: EpochSpan[] = []
  for (const mjd of [...mjds].sort((a, b) => a - b)) {
    const last = epochs.at(-1)
    if (last && mjd - last.end <= EPOCH_GAP_DAYS) {
      last.end = mjd
      last.count += 1
    } else {
      epochs.push({ start: mjd, end: mjd, count: 1 })
    }
  }
  return epochs
}

// The archive writes dates without a zone; they are UTC.
export const isoToMjd = (iso: string) =>
  Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / DAY_MS + MJD_UNIX_EPOCH

// A little air on both sides, so the first and last dot are not cut by the frame.
export function dateDomain(mjds: number[]): [number, number] {
  const lo = Math.min(...mjds)
  const hi = Math.max(...mjds)
  const pad = Math.max(5, (hi - lo) * 0.04)
  return [lo - pad, hi + pad]
}

export interface TimeTick {
  mjd: number
  label: string
}

// First days of months (YYYY-MM), thinned to at most `max`; a span shorter than two months
// gets its two ends as full dates instead.
export function timeTicks([start, end]: [number, number], max = 6): TimeTick[] {
  const first = new Date((start - MJD_UNIX_EPOCH) * DAY_MS)
  const months: number[] = []
  for (let i = 1; ; i++) {
    const mjd =
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1) / DAY_MS + MJD_UNIX_EPOCH
    if (mjd > end) break
    months.push(mjd)
  }
  if (months.length < 2) return [start, end].map((mjd) => ({ mjd, label: isoDate(mjd) }))
  const step = Math.ceil(months.length / max)
  return months
    .filter((_, i) => i % step === 0)
    .map((mjd) => ({ mjd, label: isoDate(mjd).slice(0, 7) }))
}
