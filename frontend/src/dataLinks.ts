import type { Frame, FrameManifest } from './types'

// An outside page; `site` says where the link goes.
export interface DataLink {
  label: string
  site: string
  url: string
}

export const CROSS_CHECK_RADIUS_ARCMIN = 1
// WiseView's own default field of view (arcsec).
export const WISEVIEW_SIZE_ARCSEC = 176
// Measured (Content-Length of six DR1 Level-2 files on S3): 65.0–66.1 MB.
export const LEVEL2_FILE_SIZE = 'about 65 MB'

export const formatDeg = (value: number) => value.toFixed(5)
const signedDeg = (value: number) => `${value >= 0 ? '+' : ''}${formatDeg(value)}`

// Firefly URL API (`?api=image&url=`): the IRSA Viewer loads the FITS file from that URL.
export function irsaViewerUrl(fitsUrl: string): string {
  return `https://irsa.ipac.caltech.edu/irsaviewer/?${new URLSearchParams({ api: 'image', url: fitsUrl })}`
}

// WISE band WiseView should blink: 1 = W1 (3.4 µm), 2 = W2 (4.6 µm), 3 = W1+W2.
export function wiseBand(detector: number): 1 | 2 | 3 {
  if (detector >= 5) return 2 // D5–D6 (3.8–5.0 µm) overlap W2
  if (detector === 4) return 1 // D4 (2.4–3.8 µm) overlaps W1
  return 3 // D1–D3 lie below both WISE bands: the deeper combined view
}

const WISE_BAND_NAME = { 1: 'W1', 2: 'W2', 3: 'W1+W2' } as const

// WiseView reads ra/dec in decimal degrees and `size` as the field of view in arcsec.
export function wiseViewUrl(ra: number, dec: number, detector: number): string {
  const hash = `ra=${formatDeg(ra)}&dec=${formatDeg(dec)}&size=${WISEVIEW_SIZE_ARCSEC}&band=${wiseBand(detector)}`
  return `http://byw.tools/wiseview#${hash}`
}

// SIMBAD cone search on the CfA mirror (CDS was unreachable during the hackathon).
export function simbadUrl(ra: number, dec: number): string {
  const params = new URLSearchParams({
    Coord: `${formatDeg(ra)} ${signedDeg(dec)}`,
    CooFrame: 'ICRS',
    CooEpoch: '2000',
    CooEqui: '2000',
    Radius: String(CROSS_CHECK_RADIUS_ARCMIN),
    'Radius.unit': 'arcmin',
    submit: 'submit query',
  })
  return `https://simbad.cfa.harvard.edu/simbad/sim-coo?${params}`
}

// Gaia DR3 (VizieR I/355/gaiadr3) around the position, nearest first, on the CfA mirror.
export function vizierGaiaUrl(ra: number, dec: number): string {
  const params = new URLSearchParams({
    '-source': 'I/355/gaiadr3',
    '-c': `${formatDeg(ra)} ${signedDeg(dec)}`,
    '-c.rs': String(CROSS_CHECK_RADIUS_ARCMIN * 60),
    '-sort': '_r',
    '-out.max': '50',
  })
  return `https://vizier.cfa.harvard.edu/viz-bin/VizieR-4?${params}`
}

export function frameLinks(frame: Pick<Frame, 'source_url' | 'cloud_url'>): DataLink[] {
  return [
    { label: 'Cutout FITS used for this frame', site: 'IRSA', url: frame.source_url },
    ...(frame.cloud_url
      ? [{ label: `Full Level-2 image, FITS, ${LEVEL2_FILE_SIZE}`, site: 'AWS S3', url: frame.cloud_url }]
      : []),
    { label: 'Open the cutout in IRSA Viewer', site: 'IRSA Viewer', url: irsaViewerUrl(frame.source_url) },
  ]
}

export function crossCheckLinks({ ra, dec, detector }: Pick<FrameManifest, 'ra' | 'dec' | 'detector'>): DataLink[] {
  const radius = `${CROSS_CHECK_RADIUS_ARCMIN}′`
  return [
    {
      label: `WISE ${WISE_BAND_NAME[wiseBand(detector)]} blink of this position`,
      site: 'WiseView',
      url: wiseViewUrl(ra, dec, detector),
    },
    { label: `Known sources within ${radius}`, site: 'SIMBAD (CfA mirror)', url: simbadUrl(ra, dec) },
    { label: `Gaia DR3 sources within ${radius}`, site: 'VizieR (CfA mirror)', url: vizierGaiaUrl(ra, dec) },
  ]
}

const FLAGS_DOC: DataLink = {
  label: 'Pixel flags: Explanatory Supplement, Table 16 (PDF)',
  site: 'IRSA',
  url: 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf#page=33',
}
const IMAGE_FILE_DOC: DataLink = {
  label: 'SPHEREx image file: IMAGE, FLAGS, VARIANCE, WCS-WAVE',
  site: 'IRSA docs',
  url: 'https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/#main-science-data-product-spectral-image-multi-extension-fits-files-mef',
}

export const LEARN_LINKS: DataLink[] = [
  { label: 'SPHEREx tutorial notebooks', site: 'IRSA', url: 'https://caltech-ipac.github.io/irsa-tutorials/spherex/' },
  { label: 'Cutouts tutorial: how these frames are fetched', site: 'IRSA', url: 'https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/' },
  IMAGE_FILE_DOC,
  FLAGS_DOC,
  { label: 'SPHEREx Level 1–3 pipeline code', site: 'GitHub', url: 'https://github.com/Caltech-IPAC/spherex-pipelines' },
  { label: 'Notebook sources', site: 'GitHub', url: 'https://github.com/Caltech-IPAC/irsa-tutorials' },
  { label: 'IRSA Viewer source (Firefly)', site: 'GitHub', url: 'https://github.com/Caltech-IPAC/firefly' },
  { label: 'Challenge: Planet X and SPHEREx', site: 'NASA Space Apps', url: 'https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/' },
  { label: 'Space Apps discussions', site: 'GitHub', url: 'https://github.com/nasa/spaceapps/discussions' },
]

const CHECK_DOCS: Record<string, DataLink> = {
  FLAGGED_PIXELS: FLAGS_DOC,
  SPECTRUM_POINTS_FLAGGED: FLAGS_DOC,
  WAVELENGTH_MISMATCH: IMAGE_FILE_DOC,
  WAVELENGTH_CLOSE: IMAGE_FILE_DOC,
  WAVELENGTH_UNKNOWN: IMAGE_FILE_DOC,
}

// Documentation behind a check code, if there is one.
export function checkDocs(code: string): DataLink | undefined {
  return CHECK_DOCS[code]
}
