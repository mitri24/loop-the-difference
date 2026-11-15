import { describe, expect, it } from 'vitest'
import { addressFor, POLARIS, readEmbed, readMarks, readPair, readQuery, toSearch } from './url'

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

describe('candidate marks in the URL', () => {
  it('round-trip with the frame and the position, obs_ids with colons included', () => {
    const marks = [
      { obs_id: '2025W41_2B_0137_3', ra: 38.024731, dec: 89.269481 },
      { obs_id: 'ivo://irsa/spherex:2025W42_1A_0001_1', ra: 359.5, dec: -12.5 },
    ]
    const search = toSearch(POLARIS, false, marks)
    expect(readQuery(search)).toEqual(POLARIS)
    expect(readMarks(search)).toEqual(marks)
  })

  it('drops malformed marks and keeps at most two', () => {
    expect(readMarks('?mark=abc&mark=:1,2&mark=a:1&mark=a:1,95&mark=a:1,2,3&mark=a:x,2')).toEqual([])
    expect(readMarks('?mark=a:1,2&mark=b:3,4&mark=c:5,6').map((m) => m.obs_id)).toEqual(['a', 'b'])
    expect(readMarks('?mark=a:-10,2&mark=b:370,2')).toEqual([{ obs_id: 'a', ra: 350, dec: 2 }, { obs_id: 'b', ra: 10, dec: 2 }])
  })

  it('stay out of a link without marks', () => {
    expect(toSearch(POLARIS)).not.toContain('mark')
  })
})

describe('the blink pair in a link', () => {
  it('reads A and B as obs_ids and writes them after the marks', () => {
    expect(readPair('?ra=1&dec=2&a=obs-a&b=obs-b')).toEqual({ a: 'obs-a', b: 'obs-b' })
    const search = toSearch({ ra: '1', dec: '2', fov: 0.2, band: 6, mode: 'exposures' }, false, [], { a: 'obs-a', b: 'obs-b' })
    expect(search).toBe('?ra=1&dec=2&fov=0.2&band=6&a=obs-a&b=obs-b')
    expect(readPair(search)).toEqual({ a: 'obs-a', b: 'obs-b' })
  })

  it('ignores a half pair or the same frame twice', () => {
    expect(readPair('?ra=1&dec=2&a=obs-a')).toBeNull()
    expect(readPair('?ra=1&dec=2&a=obs-a&b=obs-a')).toBeNull()
    expect(readPair('?ra=1&dec=2&a=%20&b=obs-b')).toBeNull()
  })
})


describe('multiple marked objects in shared links', () => {
  it('keeps each object separate even when they share an observation', () => {
    const marks = [
      { obs_id: 'frame-1', ra: 10, dec: 20, object: 0 },
      { obs_id: 'frame-2', ra: 11, dec: 21, object: 0 },
      { obs_id: 'frame-1', ra: 30, dec: 40, object: 1 },
    ]
    expect(readMarks(toSearch(POLARIS, false, marks))).toEqual(marks)
  })
  it('rejects invalid object indices and positions', () => {
    expect(readMarks('?objectmark=-1:obs:10,20&objectmark=1.5:obs:10,20&objectmark=1:obs:10,99')).toEqual([])
  })
})


it('round-trips more than twenty objects without truncating their marks', () => {
  const marks = Array.from({ length: 125 }, (_, object) => [
    { obs_id: 'first', ra: 10, dec: 20, object },
    { obs_id: 'second', ra: 11, dec: 21, object },
  ]).flat()
  expect(readMarks(toSearch(POLARIS, false, marks))).toEqual(marks)
})


it('preserves the requested comparison link, its marked position and selected A/B observations', () => {
  const search = '?ra=27.198635&dec=89.314570&fov=0.2&band=6&mark=2025W42_1A_0084_1%3A21.830601%2C89.283490&a=2025W39_1A_0467_4&b=2026W38_1A_0567_1'
  const query = readQuery(search)!
  const marks = readMarks(search)
  const pair = readPair(search)
  expect(query).toMatchObject({ ra: '27.198635', dec: '89.314570', fov: 0.2, band: 6 })
  expect(marks).toEqual([{ obs_id: '2025W42_1A_0084_1', ra: 21.830601, dec: 89.283490 }])
  expect(pair).toEqual({ a: '2025W39_1A_0467_4', b: '2026W38_1A_0567_1' })
  const restored = toSearch(query, false, marks, pair)
  expect(readMarks(restored)).toEqual(marks)
  expect(readPair(restored)).toEqual(pair)
})

describe('addressFor', () => {
  it('keeps the bare address for the untouched default view', () => {
    expect(addressFor(POLARIS, null)).toBe('')
  })
  it('writes the parameters once something is chosen or the link had them', () => {
    expect(addressFor({ ...POLARIS, band: 3 }, null)).toContain('band=3')
    expect(addressFor({ ...POLARIS, name: 'Polaris' }, null)).toContain('name=Polaris')
    expect(addressFor(POLARIS, POLARIS)).toContain('ra=') // a link to Polaris itself is never stripped
    expect(addressFor(POLARIS, null, false, [], { a: 'x', b: 'y' })).toContain('a=x')
    expect(addressFor(POLARIS, null, true)).toContain('embed=1')
  })
})
