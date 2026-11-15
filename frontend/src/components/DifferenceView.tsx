import { useState, type KeyboardEvent } from 'react'
import { changeSummary, residualText, type PairChanges } from '../pairDifference'
import type { Frame, FrameManifest } from '../types'
import { SEVERITY } from './EvidencePanel'
import { ObservationImage } from './ObservationImage'
import { Skeleton } from './Skeleton'

type Shown = 'significance' | 'difference'

export function epochLabel(frame: Frame | undefined, index: number): string {
  if (!frame) return `Image ${index + 1}`
  const end = frame.date_end?.slice(0, 10)
  const start = frame.date.slice(0, 10)
  return end && end !== start ? `${start} – ${end}` : start
}

// The changes of the blink's own A and B as an image: the significance S (ZOGY) or the difference itself. The result
// comes first; the list of changes and how they were found stay folded. A pair that does not compare shows its reason,
// and its images only for inspection.
export function DifferenceView({ manifest, changes }: { manifest: FrameManifest; changes: PairChanges }) {
  const [shown, setShown] = useState<Shown>('significance')
  const [inspect, setInspect] = useState(false)
  const { pair, result } = changes
  const frames = manifest.frames
  if (!pair) return null
  const index = { A: pair.a, B: pair.b }
  const label = (letter: 'A' | 'B') => epochLabel(frames[index[letter]], index[letter])
  const visible = result && (result.comparable || inspect) ? result : null
  const src = visible && (shown === 'significance' ? visible.significance_url : visible.difference_url)
  const options: [Shown, string][] = [
    ['significance', result?.method === 'direct' ? 'Significance (direct)' : 'Significance (ZOGY)'],
    ['difference', 'Difference'],
  ]
  // Arrow keys move the choice, as in the images switch; they do not step frames here.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = shown === 'significance' ? 'difference' : 'significance'
    setShown(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[value="${next}"]`)?.focus()
  }

  return (
    <div className="player diff-player">
      <div className="viewport">
        {src ? <ObservationImage key={src} src={src} alt={`${options.find(([kind]) => kind === shown)?.[1]} of B against A`} />
          : changes.status === 'loading' ? <Skeleton variant="image" />
          : <p className="diff-empty">No image of this pair</p>}
        <div className="reticle" aria-hidden="true" />
        <span className="stamp">
          {visible && !visible.comparable && 'Inspection only · '}A {label('A')} → B {label('B')}
        </span>
      </div>

      <div className="player-side">
        <p className="change-summary" role="status">{changeSummary(changes)}</p>
        {result && !result.comparable && !inspect && (
          <button type="button" className="text-button" onClick={() => setInspect(true)}>Show the images for inspection only</button>
        )}
        {visible && <>
          <div className="images-toggle">
            <div className="segments" role="radiogroup" aria-label="Difference view" onKeyDown={onKeyDown}>
              {options.map(([kind, text]) => (
                <button key={kind} type="button" role="radio" value={kind} aria-checked={shown === kind}
                  tabIndex={shown === kind ? 0 : -1} onClick={() => setShown(kind)}>{text}</button>
              ))}
            </div>
            <p className="images-hint">{shown === 'significance'
              ? 'How significant each change is, from −7σ to +7σ, with the PSFs of A and B matched.'
              : 'B minus A scaled to B’s brightness, at ±5 times its scatter.'}</p>
          </div>
          <ul className="diff-legend" aria-label="Legend">
            <li><span className="swatch earlier" aria-hidden="true" /> brighter in A</li>
            <li><span className="swatch none" aria-hidden="true" /> no change</li>
            <li><span className="swatch later" aria-hidden="true" /> brighter in B</li>
          </ul>
        </>}
        {result && result.residuals.length > 0 && (
          <details className="disclosure">
            <summary>Changes ≥ 5σ · {result.residuals.length}</summary>
            <ol className="residual-list">
              {result.residuals.map((residual) => (
                <li key={`${residual.x}:${residual.y}`}>
                  <strong>{residualText(residual)}</strong>
                  <span className="muted"> · RA {residual.ra.toFixed(5)}° Dec {residual.dec.toFixed(5)}°</span>
                  <p>{residual.explanation}</p>
                </li>
              ))}
            </ol>
          </details>
        )}
        {result && (
          <details className="disclosure">
            <summary>How the changes were found</summary>
            {/* Rows as in the Quality tab (EvidencePanel): the severity as a pill beside the title. */}
            <div className="evidence">
              <ul className="check-list">
                {result.checks.map((check) => {
                  const { icon, word, tone } = SEVERITY[check.severity]
                  return (
                    <li key={check.code} className={`check-item check-item--${tone}`}>
                      <span className="check-item__icon" aria-hidden="true">{icon}</span>
                      <div>
                        <div className="check-item__title">
                          <span><span className="sr-only">{word}: </span>{check.message}</span>
                          <span className="check-item__label" aria-hidden="true">{word}</span>
                        </div>
                        {check.detail && <p className="check-item__text">{check.detail}</p>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </details>
        )}
        <p className="caveat">Changes are candidates: motion, variability or artefacts that need verification.</p>

        <dl className="meta">
          {(['A', 'B'] as const).map((letter) => {
            const frame = frames[index[letter]]
            return [
              <dt key={`${letter}-dt`}>{letter}</dt>,
              <dd key={`${letter}-dd`}>
                {label(letter)}
                {frame && (
                  <>
                    {` · D${frame.detector} · `}
                    <a href={frame.source_url} target="_blank" rel="noreferrer">{frame.obs_id}</a>
                    {frame.n_combined > 1 && ` (stack of ${frame.n_combined})`}
                  </>
                )}
              </dd>,
            ]
          })}
        </dl>
      </div>
    </div>
  )
}
