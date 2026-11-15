import { useState } from 'react'
import { api } from './api/client'
import type { Releases } from './api/types'

export function AnalysisReleaseInfo() {
  const [releases, setReleases] = useState<Releases | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try { setReleases(await api.releases(true)) }
    catch(e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="disclosure" aria-label="Analysis data releases">
    <h3>Analysis data releases</h3>
    <p className="muted">The additional analysis engine discovers available SPHEREx collections from IRSA. Existing comparison provenance stays in Data.</p>
    <button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking IRSA…' : 'Check for new SPHEREx data now'}</button>
    {error && <p role="alert">{error}</p>}
    {releases && <><ul>{releases.collections.map(c => <li key={c.name}>{c.name} · {c.label}</li>)}</ul>
      <p className="muted">{releases.source} · {releases.checked_at ?? 'Check time unavailable'}</p>
      {releases.error && <p role="alert">Last refresh failed: {releases.error}</p>}</>}
  </section>
}
