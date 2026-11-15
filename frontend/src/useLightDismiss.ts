import { useEffect, type RefObject } from 'react'

// A menu opened from a header button closes on Escape, on a press outside its button and menu, and when the focus
// leaves them, so two never stay open together. Escape is consumed: an open sheet behind the menu stays open (App
// closes sheets on Escape).
export function useLightDismiss(open: boolean, setOpen: (open: boolean) => void,
  trigger: RefObject<HTMLElement | null>, menu: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      if (menu.current?.contains(document.activeElement)) trigger.current?.focus()
      setOpen(false)
    }
    const onOutside = (event: Event) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    // Capture: the sky map handles its own presses and must still close the menu.
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('focusin', onOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('focusin', onOutside)
    }
  }, [open, setOpen, trigger, menu])
}
