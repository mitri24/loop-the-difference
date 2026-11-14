import { MATCHES, MATCH_STYLE, brightestFirst, catalogMag, countSources } from '../sourceLayer'
import type { DetectedSource, Frame } from '../types'

interface Props {
  // The frame the blink shows; its sources come with the manifest.
  frame: Frame | null | undefined
  onSelect: (ra: number, dec: number) => void
  maxRows?: number
}

const fmt = (deg: number) => `${deg.toFixed(5)}°`.replace('-', '−')

function rowText(source: DetectedSource) {
  const evidence = source.catalog_id
    ? [
        source.catalog_id,
        source.separation_arcsec == null ? null : `${source.separation_arcsec.toFixed(1)}″ away`,
        catalogMag(source),
      ]
    : [MATCH_STYLE[source.match].word]
  return evidence.filter(Boolean).join(' · ')
}

// Every point source of the shown frame with the catalogue that lists something there.
export function SourceList({ frame, onSelect, maxRows = 50 }: Props) {
  if (!frame) return <p className="source-empty">Sources appear once frames are loaded.</p>
  const sources = frame.sources
  if (!sources) {
    return (
      <p className="source-empty">
        These frames were prepared before source detection existed: loading the view again lists
        their sources.
      </p>
    )
  }
  const counts = countSources(sources)
  const rows = brightestFirst(sources).slice(0, maxRows)
  return (
    <section className="source-list" aria-label="Sources detected in this frame">
      <h3>
        {counts.detected} {counts.detected === 1 ? 'source' : 'sources'} detected (≥ 5σ)
      </h3>
      <p className="source-provenance">
        Frame {frame.index + 1}: {frame.obs_id} · {frame.date.slice(0, 10)} UTC · detector D
        {frame.detector}
      </p>
      <ul className="source-legend">
        {MATCHES.map((match) => (
          <li key={match} className={`src-${match}`}>
            <span className="source-glyph" aria-hidden="true">
              {MATCH_STYLE[match].glyph}
            </span>{' '}
            {MATCH_STYLE[match].word}: <strong>{counts[match]}</strong>
          </li>
        ))}
      </ul>
      {sources.length === 0 ? (
        <p className="source-empty">No point source above 5σ in this frame.</p>
      ) : (
        <ol className="source-rows">
          {rows.map((source) => (
            <li key={`${source.ra},${source.dec}`} className={`src-${source.match}`}>
              <button type="button" onClick={() => onSelect(source.ra, source.dec)}>
                <span className="source-glyph" aria-hidden="true">
                  {MATCH_STYLE[source.match].glyph}
                </span>
                <span className="source-evidence">{rowText(source)}</span>
                <span className="source-numbers">
                  S/N {source.snr.toFixed(1)} · RA {fmt(source.ra)} Dec {fmt(source.dec)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {sources.length > rows.length && (
        <p className="source-hint">
          Showing the {rows.length} brightest of {sources.length}.
        </p>
      )}
      <p className="source-hint">
        A match means the catalogue lists a source at about the same position, not that it is the
        same object. A source without a match needs verification; it is not a discovery.
      </p>
    </section>
  )
}
