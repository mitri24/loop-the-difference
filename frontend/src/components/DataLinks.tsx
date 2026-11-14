import { checkDocs, crossCheckLinks, formatDeg, frameLinks, LEARN_LINKS, type DataLink } from '../dataLinks'
import type { Frame, FrameManifest } from '../types'

export function ExternalLink({ link }: { link: DataLink }) {
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer">
      {link.label}
      <span className="link-site"> · {link.site}</span>
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

// Documentation for a check, e.g. the SPHEREx FLAGS bits behind FLAGGED_PIXELS.
export function CheckDocsLink({ code }: { code: string }) {
  const doc = checkDocs(code)
  return doc ? <small className="check-docs"><ExternalLink link={doc} /></small> : null
}

function LinkList({ links }: { links: DataLink[] }) {
  return (
    <ul className="data-links-list">
      {links.map((link) => (
        <li key={link.url}>
          <ExternalLink link={link} />
        </li>
      ))}
    </ul>
  )
}

interface Props {
  manifest: Pick<FrameManifest, 'ra' | 'dec' | 'detector'>
  // The frame on screen; without one only the position links are shown.
  frame?: Frame | null
}

export function DataLinks({ manifest, frame }: Props) {
  return (
    <section className="data-links" aria-label="Data and cross-check links">
      {frame && (
        <>
          <h3>Data for this frame</h3>
          <p className="muted">
            {frame.n_combined > 1 ? `First of ${frame.n_combined} stacked exposures: ` : 'Exposure '}
            {frame.obs_id} · D{frame.detector} · {frame.date.slice(0, 10)}
          </p>
          <LinkList links={frameLinks(frame)} />
        </>
      )}
      <h3>Cross-check this position</h3>
      <p className="muted">
        RA {formatDeg(manifest.ra)}°, Dec {formatDeg(manifest.dec)}°. A catalogue match is a known
        source; no match still needs verification.
      </p>
      <LinkList links={crossCheckLinks(manifest)} />
    </section>
  )
}

// Tutorials, docs and code behind the data; shown in About.
export function LearnLinks() {
  return <LinkList links={LEARN_LINKS} />
}
