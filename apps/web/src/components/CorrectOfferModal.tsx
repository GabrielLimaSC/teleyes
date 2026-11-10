import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CHROME_SPRING_MS, prefersReducedMotion } from '../chrome/scrollChrome'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { CONFIRM_DIALOG_ATTR } from './ConfirmDialog'
import './CorrectOfferModal.css'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export interface CorrectOfferModalProps {
  open: boolean
  title: string
  subtitle?: string
  /** Every way of dismissing: ✕, backdrop and Esc. Ignored while `busy`. */
  onClose: () => void
  busy?: boolean
  children: ReactNode
}

/**
 * S25-F3 (tela B2): the desktop "Corrigir oferta" modal. The phone keeps the
 * product sheet (tela 07), so this is only mounted by `ProductPanel` outside
 * the phone layout.
 *
 * Enters and leaves on the chrome spring (`--chrome-spring`, 1ms under
 * `prefers-reduced-motion`): it stays mounted for `CHROME_SPRING_MS` after
 * `open` turns false so the exit can play. Carries `data-confirm-dialog` so
 * the product panel behind it leaves Esc and outside clicks alone, and traps
 * Tab itself (stopping the event) because the panel's own trap would
 * otherwise pull focus back out of this portal.
 */
export function CorrectOfferModal({ open, title, subtitle, onClose, busy = false, children }: CorrectOfferModalProps) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  useEffect(() => {
    onCloseRef.current = onClose
    busyRef.current = busy
  })

  useEffect(() => {
    if (open) {
      setMounted(true)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true))
      })
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
      }
    }
    setVisible(false)
    const timer = window.setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : CHROME_SPRING_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  // Focus is only returned to the opener (no document-level trap, see above).
  useDialogFocus(dialogRef, mounted && open, false)

  useEffect(() => {
    if (!mounted || !open) return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = originalOverflow
    }
  }, [mounted, open])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    event.stopPropagation()
    const container = dialogRef.current
    if (container === null) return
    const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
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

  if (!mounted) return null

  return createPortal(
    <div
      className="correct-offer-modal__backdrop"
      data-state={visible && open ? 'open' : 'closed'}
      role="presentation"
      {...{ [CONFIRM_DIALOG_ATTR]: true }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="plane-glass correct-offer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="correct-offer-modal__header">
          <div className="correct-offer-modal__heading">
            <h2 id={titleId} className="correct-offer-modal__title">
              {title}
            </h2>
            {subtitle && <p className="correct-offer-modal__subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="correct-offer-modal__close"
            aria-label="Fechar"
            onClick={onClose}
            disabled={busy}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="correct-offer-modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
