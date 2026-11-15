import { useState } from 'react'
import { Skeleton } from './Skeleton'

// Keep a failed archive image recoverable instead of leaving an unexplained black viewport.
export function ObservationImage({ src, alt, visible = true }: { src: string; alt: string; visible?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  return <>
    <img src={attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src}
      alt={alt} decoding="async" fetchPriority={visible ? 'high' : 'low'} style={{ visibility: visible ? 'visible' : 'hidden' }}
      onError={() => setFailed(true)} onLoad={() => { setFailed(false); setLoaded(true) }} />
    {!loaded && !failed && visible && <Skeleton />}
    {failed && visible && <div className="image-error" role="alert">
      <span>This observation image could not load.</span>
      <button type="button" onClick={() => { setFailed(false); setLoaded(false); setAttempt(Date.now()) }}>Retry image</button>
    </div>}
  </>
}
