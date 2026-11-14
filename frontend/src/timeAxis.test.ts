import { describe, expect, it } from 'vitest'
import { dateDomain, groupEpochs, isoToMjd, timeTicks } from './timeAxis'

describe('time axis', () => {
  it('splits epochs like backend group_epochs: a gap of more than 30 days', () => {
    expect(groupEpochs([60900, 60800, 60830, 60861])).toEqual([
      { start: 60800, end: 60830, count: 2 },
      { start: 60861, end: 60861, count: 1 },
      { start: 60900, end: 60900, count: 1 },
    ])
  })

  it('reads archive dates without a zone as UTC', () => {
    expect(isoToMjd('2025-05-01T00:00:00')).toBe(60796)
    expect(isoToMjd('2025-05-01T12:00:00Z')).toBe(60796.5)
  })

  it('pads the domain, also around a single date', () => {
    expect(dateDomain([60796])).toEqual([60791, 60801])
    const [lo, hi] = dateDomain([60796, 61196])
    expect(lo).toBeCloseTo(60780)
    expect(hi).toBeCloseTo(61212)
  })

  it('ticks months across a year and the two ends across a few days', () => {
    const year = timeTicks([60796, 61161])
    expect(year.length).toBeLessThanOrEqual(6)
    expect(year[0].label).toBe('2025-06')
    expect(timeTicks([60796, 60800]).map((t) => t.label)).toEqual(['2025-05-01', '2025-05-05'])
  })
})
