import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { POLARIS } from '../url'
import { SearchBar, splitCoordinates } from './SearchBar'

describe('splitCoordinates', () => {
  it('passes "RA, Dec" in degrees or sexagesimal to the backend as two parts', () => {
    expect(splitCoordinates('269.45, 4.69')).toEqual({ ra: '269.45', dec: '4.69' })
    expect(splitCoordinates('02:31:49.09, +89:15:50.8')).toEqual({ ra: '02:31:49.09', dec: '+89:15:50.8' })
    expect(splitCoordinates('08h55m10.831s -7d14m42.53s')).toEqual({ ra: '08h55m10.831s', dec: '-7d14m42.53s' })
  })
  it('treats anything else as a name', () => {
    expect(splitCoordinates("Barnard's Star")).toBeNull()
    expect(splitCoordinates('WISE 0855')).toBeNull()
    expect(splitCoordinates('3C 273')).toBeNull()
    expect(splitCoordinates('M31')).toBeNull()
    expect(splitCoordinates('269.45')).toBeNull()
    expect(splitCoordinates('')).toBeNull()
  })
})

describe('SearchBar', () => {
  it('shows the example targets and Share next to the search', () => {
    const html = renderToStaticMarkup(<SearchBar value="" onChange={() => undefined} draft={POLARIS} busy={false}
      onShow={() => undefined} onFind={() => undefined} onShare={() => undefined} />)
    for (const label of ["Barnard's Star", 'WISE 0855', 'Epsilon Indi B', 'RW Aurigae', 'R Draconis', 'Pluto', 'Polaris']) {
      expect(html).toContain(`>${label.replace("'", '&#x27;')}</button>`)
    }
    expect(html).toContain('>Share</button>')
  })
})
