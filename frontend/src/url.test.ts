import { describe, expect, it } from 'vitest'
import { POLARIS, readEmbed, readQuery, toSearch } from './url'

describe('target in the URL', () => {
  it('needs both coordinates', () => {
    expect(readQuery('')).toBeNull()
    expect(readQuery('?ra=10')).toBeNull()
  })

  it('keeps the typed coordinates and fills in the defaults', () => {
    expect(readQuery('?ra=08h55m10.831s&dec=-7d14m42.53s')).toEqual({
      ra: '08h55m10.831s',
      dec: '-7d14m42.53s',
      fov: 0.2,
      band: 6,
      mode: 'exposures',
    })
  })

  it('accepts a raw plus sign typed into the address bar', () => {
    expect(readQuery('?ra=02:31:49.09&dec=+89:15:50.8')?.dec).toBe('89:15:50.8')
  })

  it('clamps field of view and band, and ignores garbage', () => {
    expect(readQuery('?ra=1&dec=2&fov=50&band=9')).toMatchObject({ fov: 1, band: 6 })
    expect(readQuery('?ra=1&dec=2&fov=abc&band=')).toMatchObject({ fov: 0.2, band: 6 })
  })

  it('round-trips through the URL', () => {
    expect(readQuery(toSearch(POLARIS))).toEqual(POLARIS)
  })

  it('reads the view mode and falls back to exposures for unknown values', () => {
    expect(readQuery('?ra=1&dec=2&mode=stacks')?.mode).toBe('stacks')
    expect(readQuery('?ra=1&dec=2&mode=difference')?.mode).toBe('difference')
    expect(readQuery('?ra=1&dec=2&mode=Stacks')?.mode).toBe('exposures')
    expect(readQuery('?ra=1&dec=2&mode=')?.mode).toBe('exposures')
    expect(readQuery('?ra=1&dec=2')?.mode).toBe('exposures')
  })

  it('writes the view mode only when it is not the default', () => {
    expect(toSearch(POLARIS)).not.toContain('mode=')
    const stacks = { ...POLARIS, mode: 'stacks' as const }
    expect(toSearch(stacks)).toContain('mode=stacks')
    expect(readQuery(toSearch(stacks))).toEqual(stacks)
    expect(readQuery(toSearch(stacks, true))).toEqual(stacks)
  })

  it('reads embed mode only from embed=1', () => {
    expect(readEmbed('?ra=1&dec=2&embed=1')).toBe(true)
    expect(readEmbed('?ra=1&dec=2')).toBe(false)
    expect(readEmbed('?embed=0')).toBe(false)
    expect(readEmbed('?embed=true')).toBe(false)
  })

  it('keeps embed mode in the URL it writes', () => {
    expect(readEmbed(toSearch(POLARIS, true))).toBe(true)
    expect(readEmbed(toSearch(POLARIS))).toBe(false)
    expect(readQuery(toSearch(POLARIS, true))).toEqual(POLARIS)
  })

  it('keeps the target name, and leaves it out when there is none', () => {
    const barnard = { ...POLARIS, name: "Barnard's Star" }
    expect(readQuery(toSearch(barnard))).toEqual(barnard)
    expect(readQuery('?ra=1&dec=2&name=%20')).not.toHaveProperty('name')
    expect(toSearch(POLARIS)).not.toContain('name=')
  })
})
