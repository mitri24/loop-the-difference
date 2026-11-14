import type { ObservationSummary } from '../types'

export function ObservationInfo({ summary, band }: { summary: ObservationSummary; band: number }) {
  const inBand = summary.detectors[String(band)] ?? 0

  return (
    <section className="info">
      <h2>SPHEREx coverage</h2>
      <p>
        {summary.count} observations in {summary.epochs.length}{' '}
        {summary.epochs.length === 1 ? 'epoch' : 'epochs'} · {inBand} in D{band}
      </p>
      <ul>
        {summary.epochs.map((epoch) => (
          <li key={epoch.start}>
            {epoch.start.slice(0, 10)} → {epoch.end.slice(0, 10)}
            <span className="muted"> · {epoch.count}</span>
          </li>
        ))}
      </ul>
      {inBand === 0 && summary.count > 0 && (
        <p className="notice">No observations in D{band} here – try another detector.</p>
      )}
    </section>
  )
}
