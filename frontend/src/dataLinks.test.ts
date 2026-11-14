import { describe, expect, it } from 'vitest'
import {
  checkDocs,
  crossCheckLinks,
  frameLinks,
  irsaViewerUrl,
  simbadUrl,
  vizierGaiaUrl,
  wiseBand,
  wiseViewUrl,
} from './dataLinks'

// WISE 0855−0714 and one of its real SPHEREx D6 cutouts (spherex_dr1).
const RA = 133.79513
const DEC = -7.24515
const CUTOUT =
  'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits?center=133.795130,-7.245150&size=0.2830'
const CLOUD =
  'https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits'

describe('link builders', () => {
  it('hands the cutout URL to the IRSA Viewer image API unchanged', () => {
    const url = new URL(irsaViewerUrl(CUTOUT))

    expect(url.origin + url.pathname).toBe('https://irsa.ipac.caltech.edu/irsaviewer/')
    expect(url.searchParams.get('api')).toBe('image')
    expect(url.searchParams.get('url')).toBe(CUTOUT)
  })

  it('opens WiseView on the position in the WISE band next to the detector', () => {
    expect(wiseViewUrl(RA, DEC, 6)).toBe('http://byw.tools/wiseview#ra=133.79513&dec=-7.24515&size=176&band=2')
    expect([1, 2, 3, 4, 5, 6].map(wiseBand)).toEqual([3, 3, 3, 1, 2, 2])
  })

  it('searches SIMBAD and Gaia DR3 within one arcminute on the CfA mirrors', () => {
    expect(simbadUrl(RA, DEC)).toBe(
      'https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=133.79513+-7.24515&CooFrame=ICRS&CooEpoch=2000&CooEqui=2000&Radius=1&Radius.unit=arcmin&submit=submit+query',
    )
    expect(vizierGaiaUrl(RA, DEC)).toBe(
      'https://vizier.cfa.harvard.edu/viz-bin/VizieR-4?-source=I%2F355%2Fgaiadr3&-c=133.79513+-7.24515&-c.rs=60&-sort=_r&-out.max=50',
    )
    // A northern declination keeps its sign instead of becoming a blank in the query.
    expect(new URL(simbadUrl(269.45208, 4.69336)).searchParams.get('Coord')).toBe('269.45208 +4.69336')
  })
})

describe('link lists', () => {
  it('offers the full Level-2 file only when the archive lists a cloud copy', () => {
    expect(frameLinks({ source_url: CUTOUT, cloud_url: CLOUD }).map((link) => link.site)).toEqual([
      'IRSA',
      'AWS S3',
      'IRSA Viewer',
    ])
    expect(frameLinks({ source_url: CUTOUT, cloud_url: null }).map((link) => link.site)).toEqual(['IRSA', 'IRSA Viewer'])
    expect(frameLinks({ source_url: CUTOUT }).find((link) => link.site === 'AWS S3')).toBeUndefined()
  })

  it('names the WISE band and the search radius', () => {
    const labels = crossCheckLinks({ ra: RA, dec: DEC, detector: 4 }).map((link) => link.label)

    expect(labels).toEqual([
      'WISE W1 blink of this position',
      'Known sources within 1′',
      'Gaia DR3 sources within 1′',
    ])
  })

  it('points flag and wavelength checks to the SPHEREx documentation', () => {
    expect(checkDocs('FLAGGED_PIXELS')?.url).toBe(
      'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf#page=33',
    )
    expect(checkDocs('SPECTRUM_POINTS_FLAGGED')).toBe(checkDocs('FLAGGED_PIXELS'))
    expect(checkDocs('WAVELENGTH_MISMATCH')?.url).toContain('spherex-data-products/')
    expect(checkDocs('LOW_OVERLAP')).toBeUndefined()
  })
})
