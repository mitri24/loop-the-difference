import { useEffect, useState, type RefObject } from 'react'

export interface PageSection {
  id: string
  label: string
  // A count shown beside the label (checks, marks, observations); alert = a blocking check.
  count?: number
  alert?: boolean
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Scrolls only the page itself: scrollIntoView would also move the stage around it, and with it the viewer
// head and the overview map.
export function scrollToSection(page: HTMLElement | null, id: string) {
  const section = document.getElementById(id)
  if (!page || !section) return
  const top = section.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop
  page.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
}

// One page instead of a sidebar: every section is on the page, this bar names them in order, marks the one in
// view and jumps to it (click, or the keys 1–9 while the page is shown and no field has focus).
export function SectionNav({ sections, page, active }: {
  sections: PageSection[]
  page: RefObject<HTMLElement | null>
  // Keys jump only while the page is shown.
  active: boolean
}) {
  const [current, setCurrent] = useState(sections[0]?.id)
  const ids = sections.map((section) => section.id).join(' ')

  useEffect(() => {
    const root = page.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<string, number>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.boundingClientRect.top : Infinity)
      // The section whose top is nearest the top of the page view, among those in view.
      const inView = [...visible.entries()].filter(([, top]) => top !== Infinity)
      if (inView.length) setCurrent(inView.reduce((a, b) => (Math.abs(b[1]) < Math.abs(a[1]) ? b : a))[0])
    }, { root, rootMargin: '0px 0px -55% 0px' })
    for (const id of ids.split(' ')) {
      const element = document.getElementById(id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [page, ids])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || !/^[1-9]$/.test(event.key)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .aladin-container')) return
      const section = sections[Number(event.key) - 1]
      if (!section) return
      event.preventDefault()
      setCurrent(section.id)
      scrollToSection(page.current, section.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, sections, page])

  return (
    <nav className="section-nav" aria-label="Sections of this page">
      {sections.map((section, i) => (
        <a key={section.id} href={`#${section.id}`} data-testid={`section-${section.id}`}
          aria-current={current === section.id ? 'true' : undefined} title={`${section.label} (key ${i + 1})`}
          onClick={(event) => { event.preventDefault(); setCurrent(section.id); scrollToSection(page.current, section.id) }}>
          {section.label}
          {section.count != null && section.count > 0 && (
            <span className={section.alert ? 'section-count alert' : 'section-count'}
              aria-label={section.alert ? `${section.count}, blocking check` : `${section.count}`}>{section.count}</span>
          )}
        </a>
      ))}
    </nav>
  )
}
