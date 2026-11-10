import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * S23-02: modal focus management. While `active`, Tab/Shift+Tab wrap inside
 * `containerRef`; when the dialog closes (or unmounts), focus goes back to the
 * element that had it when the dialog opened — if that element is still on the
 * page. The opener is captured in the first effect, before the dialog moves
 * focus into itself (child effects run first, so dialogs should move focus in
 * an effect of their own that runs after this hook's, or on a later tick).
 */
export function useDialogFocus(containerRef: RefObject<HTMLElement | null>, active = true, trap = true) {
  useEffect(() => {
    if (!active) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (container === null) return
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      )
      if (items.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault()
        first.focus()
      }
    }
    if (trap) document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (opener !== null && opener.isConnected) opener.focus()
    }
  }, [containerRef, active, trap])
}
