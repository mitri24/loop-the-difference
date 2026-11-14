import { useState } from 'react'

// Keep a failed archive image recoverable instead of leaving an unexplained black viewport.
export function ObservationImage({ src, alt, visible = true }: { src: string; alt: string; visible?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  return <>
    <img src={attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src}
      alt={alt} style={{ visibility: visible ? 'visible' : 'hidden' }}
      onError={() => setFailed(true)} onLoad={() => setFailed(false)} />
    {failed && visible && <div className="image-error" role="alert">
      <span>This observation image could not load.</span>
      <button type="button" onClick={() => { setFailed(false); setAttempt(Date.now()) }}>Retry image</button>
    </div>}
  </>
}
