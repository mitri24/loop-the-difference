import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NeossatCoverage } from '../types'
import { NeossatLine, type NeossatState, neossatSummary } from './PartnerData'

const SEARCH = 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/?Observation.collection=NEOSSAT'

const coverage = (count: number, first: string | null, last: string | null): NeossatCoverage => ({
  collection: 'NEOSSAT',
  ra: 269.452,
  dec: 4.693,
  count,
  first_date: first,
  last_date: last,
  search_url: SEARCH,
  note: 'Visible-light frames from NEOSSat, not comparable with SPHEREx infrared images.',
})

const render = (state: NeossatState) =>
  renderToStaticMarkup(<NeossatLine state={state} onRetry={() => {}} />)

describe('neossatSummary', () => {
  it('names one year when every frame comes from the same year', () => {
    const summary = neossatSummary(coverage(619, '2019-10-13', '2019-12-03'))

    expect(summary).toBe('619 observations, 2019')
  })

  it('names the year range across years', () => {
    const summary = neossatSummary(coverage(3, '2019-05-18', '2024-10-05'))

    expect(summary).toBe('3 observations, 2019–2024')
  })

  it('uses the singular for one observation', () => {
    expect(neossatSummary(coverage(1, '2021-05-09', '2021-05-09'))).toBe('1 observation, 2021')
  })

  it('has no summary when no sky frame covers the position', () => {
    expect(neossatSummary(coverage(0, null, null))).toBeNull()
  })
})

describe('NeossatLine', () => {
  it('links the CADC search next to the count and the wavelength caveat', () => {
    const html = render({ status: 'ready', coverage: coverage(619, '2019-10-13', '2019-12-03') })

    expect(html).toContain('NEOSSat (CSA): 619 observations, 2019')
    expect(html).toContain('visible light, not comparable with SPHEREx')
    expect(html).toContain(`href="${SEARCH}"`)
  })

  it('says so when nothing covers the position, without a link', () => {
    const html = render({ status: 'ready', coverage: coverage(0, null, null) })

    expect(html).toContain('no NEOSSat observations cover this position')
    expect(html).not.toContain('<a')
  })

  it('shows loading and errors with a way to retry', () => {
    const error = render({ status: 'error', message: 'NEOSSat archive (CADC) is not reachable' })

    expect(render({ status: 'loading' })).toContain('checking the CADC archive')
    expect(error).toContain('NEOSSat (CSA): NEOSSat archive (CADC) is not reachable')
    expect(error).toContain('Try again')
  })
})

describe('NeossatLine while CADC is slow', () => {
  it('says that it asks again instead of showing an error', () => {
    const html = render({ status: 'loading', slow: true })
    expect(html).toContain('CADC is slow for this field – asking again…')
    expect(html).not.toContain('role="alert"')
  })
})
