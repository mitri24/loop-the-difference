import { useEffect, useRef, useState, type RefObject } from 'react'

export interface PageSection {
  id: string
  label: string
  // A count shown beside the label (checks, marks, observations); alert = a blocking check.
  count?: number
  alert?: boolean
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// A section counts as the current one once its top is within this distance of the page's top.
const SPY_OFFSET = 96

// Scrolls only the page itself (scrollIntoView would also move the stage around it, and with it the viewer
// head and the overview map) and moves the focus to the section, so keyboard and screen-reader users land there.
export function scrollToSection(page: HTMLElement | null, id: string) {
  const section = document.getElementById(id)
  if (!page || !section) return
  const top = section.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop
  page.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
  section.focus({ preventScroll: true })
}

// Which section is current (the last one whose top has reached the top band) and which are on screen,
// from the live positions, so scrolling either way and the end of the page give the right answer.
export function spy(page: HTMLElement, ids: string[]) {
  const root = page.getBoundingClientRect()
  let current = ids[0]
  const visible: string[] = []
  for (const id of ids) {
    const element = document.getElementById(id)
    if (!element) continue
    const box = element.getBoundingClientRect()
    if (box.top - root.top <= SPY_OFFSET) current = id
    if (box.bottom > root.top && box.top < root.bottom) visible.push(id)
  }
  // At the very end of the page the last section is current even if it is too short to reach the top band.
  if (page.scrollTop + page.clientHeight >= page.scrollHeight - 2 && visible.length) current = visible[visible.length - 1]
  return { current, visible }
}

// One page instead of a sidebar: every section is on the page, this bar names them in order, marks the one in
// view and jumps to it (click, or the keys 1–9 while the focus is on the page).
export function SectionNav({ sections, page, active, onVisible }: {
  sections: PageSection[]
  page: RefObject<HTMLElement | null>
  // Keys jump only while the page is shown.
  active: boolean
  // Sections that have been on screen: slow lookups wait until their section is seen.
  onVisible?: (ids: string[]) => void
}) {
  const [current, setCurrent] = useState(sections[0]?.id)
  const nav = useRef<HTMLElement>(null)
  const ids = sections.map((section) => section.id).join(' ')
  const visibleRef = useRef(onVisible)
  useEffect(() => { visibleRef.current = onVisible }, [onVisible])

  useEffect(() => {
    const root = page.current
    if (!root || !active) return
    let frame = 0
    const update = () => {
      frame = 0
      const result = spy(root, ids.split(' '))
      setCurrent(result.current)
      visibleRef.current?.(result.visible)
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update) }
    update()
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [page, ids, active])

  // The current link stays in view in the bar (it scrolls sideways on phones).
  useEffect(() => {
    const bar = nav.current
    const link = bar?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!bar || !link) return
    const left = link.offsetLeft - bar.offsetLeft
    if (left < bar.scrollLeft || left + link.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: Math.max(0, left - 16), behavior: reducedMotion() ? 'auto' : 'smooth' })
    }
  }, [current])

  // Digits jump only while the focus is on this page (WCAG 2.1.4: a one-key shortcut is scoped to its component).
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || !/^[1-9]$/.test(event.key)) return
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.viewer') || target.closest('input, textarea, select, [contenteditable="true"]')) return
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
    <nav ref={nav} className="section-nav" aria-label="Sections of this page">
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
