import type { Check, FrameManifest, ObservationSummary } from '../types'
import type { TargetQuery } from '../url'
import { EvidencePanel } from './EvidencePanel'
import { ObservationInfo } from './ObservationInfo'
import { ObservationTimeline } from './ObservationTimeline'
import { SpectrumChart } from './SpectrumChart'

interface Props {
  query: TargetQuery
  targetLabel: string
  summary: ObservationSummary | null
  manifest: FrameManifest | null | undefined
  checks: Check[]
  // The frame the player shows; undefined while the difference image is shown.
  frameIndex?: number
  onAbout: () => void
}

// Inspect: the region, its SPHEREx coverage, the spectrum at the target and how the images were prepared.
export function DataPanel({ query, targetLabel, summary, manifest, checks, frameIndex, onAbout }: Props) {
  const frame = frameIndex == null ? undefined : manifest?.frames[frameIndex]
  return (
    <>
      <div className="data-section"><p className="eyebrow">Comparison region</p><strong>{targetLabel}</strong><dl className="meta"><dt>RA</dt><dd>{query.ra}</dd><dt>Dec</dt><dd>{query.dec}</dd><dt>Region / detector</dt><dd>{query.fov}° · D{query.band}</dd><dt>Release</dt><dd>{manifest?.collection ?? summary?.collection ?? 'Not loaded yet'}</dd></dl></div>
      {summary ? <ObservationInfo summary={summary} band={query.band} /> : <p className="muted">Load a comparison to inspect coverage, observation dates and the spectrum at the target.</p>}
      {summary && <div className="data-section"><ObservationTimeline observations={summary.observations} frames={manifest?.frames} currentIndex={frameIndex} detector={manifest?.detector ?? query.band} /></div>}
      {manifest && <div className="data-section spectrum-section"><SpectrumChart key={`${manifest.ra},${manifest.dec}`} ra={`${manifest.ra}`} dec={`${manifest.dec}`}
        centerUm={(frame ?? manifest.frames[0])?.wavelength_um} detector={manifest.detector} /></div>}
      {manifest && <div className="data-section"><h3>Image preparation</h3><dl className="meta"><dt>Grid scale</dt><dd>{manifest.pixel_scale_arcsec} arcsec / pixel</dd><dt>Prepared images</dt><dd>{manifest.frames.length} · {manifest.stacked ? 'epoch stacks' : 'individual exposures'}</dd><dt>Complete</dt><dd>{manifest.complete ? 'Yes' : 'Partial · check warnings'}</dd></dl><EvidencePanel checks={checks} /></div>}
      <div className="data-section"><h3>Sky context ≠ observation evidence</h3><p>The background is a sky survey for context. The dated SPHEREx cutouts from IRSA are drawn on top of it inside the blue footprint and play in Compare. Changing a map layer does not change the observation detector.</p><p>Exact wavelength can differ between images from the same detector. A change in brightness can be a wavelength or coverage effect.</p><a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">Open SPHEREx archive ↗</a></div>
      <button type="button" onClick={onAbout}>Sources, credits & reading the images</button>
    </>
  )
}
