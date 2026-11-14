import { describe, expect, it } from 'vitest'
import { epochFor, markerLabel, positionAt, smallBodyMarkers } from './smallBodyLayer'
import type { SmallBody, SmallBodyEpoch } from './types'

// 298898 (2004 TR48) as JPL SBIdent listed it for JD 2460989.75 (fixture of the backend tests).
const body: SmallBody = {
  name: '298898 (2004 TR48)',
  ra: 45.041208333,
  dec: 17.069833333,
  vmag: 19.3,
  ra_rate: -38.24,
  dec_rate: -6.519,
  distance_arcsec: 288.7,
}

const epoch = (mjd: number, error: string | null = null): SmallBodyEpoch => ({
  mjd,
  date: '2025-11-10T06:00:00Z',
  bodies: error ? [] : [body],
  error,
  source_url: 'https://ssd-api.jpl.nasa.gov/sb_ident.api?mpc-code=500',
})

describe('small-body layer', () => {
  it('takes the closest answered epoch within a day of the frame', () => {
    const epochs = [epoch(60989.25), epoch(60990.0), epoch(61100.0)]

    expect(epochFor(epochs, 60989.3)?.mjd).toBe(60989.25)
    expect(epochFor(epochs, 60989.9)?.mjd).toBe(60990.0)
    expect(epochFor(epochs, 61050.0)).toBeNull()
  })

  it('never marks a frame from an epoch JPL did not answer', () => {
    expect(epochFor([epoch(60989.25, 'JPL SBIdent not reachable')], 60989.25)).toBeNull()
  })

  it('moves a body along its rates, the RA rate being on the sky', () => {
    // Measured from two real SBIdent answers 0.04 d apart: RA −40.0″/h (coordinate), Dec −6.56″/h.
    const anHourLater = positionAt(body, 60989.25, 60989.25 + 1 / 24)

    expect((anHourLater.ra - body.ra) * 3600).toBeCloseTo(-40.0, 1)
    expect((anHourLater.dec - body.dec) * 3600).toBeCloseTo(-6.56, 1)
    const same = positionAt(body, 60989.25, 60989.25)
    expect(same.ra).toBeCloseTo(body.ra, 9)
    expect(same.dec).toBe(body.dec)
  })

  it('wraps right ascension at 0h', () => {
    const atZero = { ...body, ra: 0.001, dec: 0, ra_rate: -36 }

    expect(positionAt(atZero, 0, 1 / 24).ra).toBeCloseTo(359.991, 3)
  })

  it('labels every marker as a known object and keeps its source', () => {
    const [marker] = smallBodyMarkers(epoch(60989.25), 60989.25)

    expect(marker.data.label).toBe('known asteroid/comet: 298898 (2004 TR48)')
    expect(marker.data.label).toBe(markerLabel(body.name))
    expect(marker.data.V).toBe('19.3')
    expect(marker.data.Source).toBe('NASA/JPL SBIdent, geocentric')
    expect(marker.ra).toBeCloseTo(body.ra, 9)
    expect(marker.dec).toBe(body.dec)
  })
})
