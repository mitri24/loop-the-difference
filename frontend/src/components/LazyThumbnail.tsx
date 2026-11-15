import { useEffect, useRef, useState } from 'react'

// Native loading="lazy" may preload the entire small gallery. Use actual visibility instead.
export function LazyThumbnail({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)
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
  return <span ref={ref} className="lazy-thumbnail">
    {ready ? <img src={src} alt={alt} decoding="async" fetchPriority="low" /> : <span aria-label={alt} className="thumbnail-placeholder" />}
  </span>
}
