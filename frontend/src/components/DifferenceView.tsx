import { useState } from 'react'
import type { Difference, Frame, FrameManifest } from '../types'
import { ObservationImage } from './ObservationImage'

// Smallest a with the largest comparable b; without any comparable pair, smallest a with the largest b.
export function defaultPair(differences: Difference[]): Difference | undefined {
  const pick = (list: Difference[]) =>
    list.reduce<Difference | undefined>(
      (best, d) => (!best || d.a < best.a || (d.a === best.a && d.b > best.b) ? d : best),
      undefined,
    )
  return pick(differences.filter((d) => d.comparable)) ?? pick(differences)
}

export function blockerText(diff: Difference): string | null {
  if (diff.comparable) return null
  const pct = diff.delta_lambda_pct
  return pct === null
    ? 'Cannot compare: wavelengths differ'
    : `Cannot compare: wavelengths differ by ${pct.toFixed(1)} %`
}

export function epochLabel(frame: Frame | undefined, index: number): string {
  if (!frame) return `Epoch ${index + 1}`
  const end = frame.date_end?.slice(0, 10)
  const start = frame.date.slice(0, 10)
  return end && end !== start ? `${start} – ${end}` : start
}

// Key by job, so the selection resets for new data. Parent renders it only with two or more epochs.
export function DifferenceView({ manifest }: { manifest: FrameManifest }) {
  const { differences, frames } = manifest
  const [pair, setPair] = useState(() => defaultPair(differences))
  if (!pair) return null

  const starts = [...new Set(differences.map((d) => d.a))].sort((x, y) => x - y)
  const ends = differences.filter((d) => d.a === pair.a).sort((x, y) => x.b - y.b)
  const selectA = (a: number) => setPair(defaultPair(differences.filter((d) => d.a === a)))
  const selectB = (b: number) => setPair(ends.find((d) => d.b === b))
  const blocker = blockerText(pair)
  const epochs: [string, number][] = [
    ['Epoch A', pair.a],
    ['Epoch B', pair.b],
  ]

  return (
    <div className="player">
      {blocker ? (
        <p className="notice error" role="alert">
          <strong>⛔ Blocker</strong> · {blocker}. Pick another pair of epochs.
        </p>
      ) : (
        <div className="viewport">
          <ObservationImage
            key={pair.url}
            src={pair.url}
            alt={`Difference between ${epochLabel(frames[pair.a], pair.a)} and ${epochLabel(frames[pair.b], pair.b)}`}
          />
          <div className="reticle" aria-hidden="true" />
          <span className="stamp">
            {epochLabel(frames[pair.a], pair.a)} → {epochLabel(frames[pair.b], pair.b)}
          </span>
        </div>
      )}

      <div className="controls">
        <label className="epoch-pick">
          Epoch A (earlier)
          <select value={pair.a} onChange={(event) => selectA(Number(event.target.value))}>
            {starts.map((a) => (
              <option key={a} value={a}>
                {epochLabel(frames[a], a)}
              </option>
            ))}
          </select>
        </label>
        <label className="epoch-pick">
          Epoch B (later)
          <select value={pair.b} onChange={(event) => selectB(Number(event.target.value))}>
            {ends.map((d) => (
              <option key={d.b} value={d.b}>
                {epochLabel(frames[d.b], d.b)}
                {d.comparable ? '' : ' (not comparable)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!blocker && (
        <>
          <ul className="diff-legend" aria-label="Legend">
            <li>
              <span className="swatch earlier" aria-hidden="true" /> brighter earlier (A)
            </li>
            <li>
              <span className="swatch none" aria-hidden="true" /> no change
            </li>
            <li>
              <span className="swatch later" aria-hidden="true" /> brighter later (B)
            </li>
          </ul>
          <p className="caveat muted">
            Coloured spots are candidates: possible motion or variability that needs verification.
          </p>
        </>
      )}

      <dl className="meta">
        {epochs.map(([label, index]) => {
          const frame = frames[index]
          return [
            <dt key={`${label}-dt`}>{label}</dt>,
            <dd key={`${label}-dd`}>
              {epochLabel(frame, index)}
              {frame && (
                <>
                  {` · D${frame.detector} · `}
                  <a href={frame.source_url} target="_blank" rel="noreferrer">
                    {frame.obs_id}
                  </a>
                  {frame.n_combined > 1 && ` (stack of ${frame.n_combined})`}
                </>
              )}
            </dd>,
          ]
        })}
      </dl>
    </div>
  )
}
