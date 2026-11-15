import { useEffect, useRef, useState } from 'react'
import { Skeleton } from './Skeleton'

// Native loading="lazy" may preload the entire small gallery. Use actual visibility instead.
// Until the image has arrived the thumbnail pulses; one that cannot load stays a still grey square.
export function LazyThumbnail({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setReady(true)
        observer.disconnect()
      }
    }, { rootMargin: '40px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <span ref={ref} className="lazy-thumbnail" aria-busy={state === 'loading'}>
    {state === 'loading' && <Skeleton />}
    {state === 'failed' && <span aria-label={alt} className="thumbnail-placeholder" />}
    {ready && state !== 'failed' && <img src={src} alt={alt} decoding="async" fetchPriority="low" hidden={state !== 'loaded'}
      onLoad={() => setState('loaded')} onError={() => setState('failed')} />}
  </span>
}
