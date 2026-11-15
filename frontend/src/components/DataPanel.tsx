import type { FrameManifest, ObservationSummary } from '../types'
import type { TargetQuery } from '../url'
import { PartnerData } from './PartnerData'

interface Props {
  query: TargetQuery
  summary: ObservationSummary | null
  manifest: FrameManifest | null | undefined
  // Partner archives are asked only while the panel is open.
  open: boolean
  onAbout: () => void
}

// Inspect: the region and how the images were prepared. Name and detector stand in the search bar, the position
// under Cross-check this position, the coverage in Observation history.
export function DataPanel({ query, summary, manifest, open, onAbout }: Props) {
  return (
    <>
      <div className="data-section"><p className="eyebrow">Comparison region</p><dl className="meta"><dt>Region</dt><dd>{query.fov}°</dd><dt>Release</dt><dd>{manifest?.collection ?? summary?.collection ?? 'Not loaded yet'}</dd></dl></div>
      {manifest && <div className="data-section"><h3>Image preparation</h3><dl className="meta"><dt>Grid scale</dt><dd>{manifest.pixel_scale_arcsec} arcsec / pixel</dd><dt>Prepared images</dt><dd>{manifest.frames.length} · {manifest.stacked ? 'epoch stacks' : 'individual exposures'}</dd><dt>Complete</dt><dd>{manifest.complete ? 'Yes' : 'Partial · see Checks'}</dd></dl></div>}
      {open && summary && <div className="data-section"><h3>Partner data</h3><PartnerData key={`${summary.ra},${summary.dec}`} ra={`${summary.ra}`} dec={`${summary.dec}`} /></div>}
      <div className="data-section"><h3>Sky context ≠ observation evidence</h3><p>The background is a sky survey for context. The dated SPHEREx cutouts from IRSA are drawn on top of it inside the blue footprint and play in the viewer. Changing a map layer does not change the observation detector.</p><p>Exact wavelength can differ between images from the same detector. A change in brightness can be a wavelength or coverage effect.</p><a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">Open SPHEREx archive ↗</a></div>
      <button type="button" onClick={onAbout}>Sources, credits & reading the images</button>
    </>
  )
}
