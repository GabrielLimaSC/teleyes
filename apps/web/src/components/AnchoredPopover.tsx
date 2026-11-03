import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './AnchoredPopover.css'

/**
 * S21-02: a small non-modal panel anchored to its trigger. Used for the "?"
 * next to "Termos incluídos" and for "Ajustes de entrega". The trigger is a
 * real button (`aria-expanded`/`aria-controls`); focus moves into the panel on
 * open; Escape closes it and returns focus; a press outside closes it too.
 * Escape never reaches the page handler (it would collapse an open rule row).
 */
export function AnchoredPopover({
  triggerLabel,
  triggerContent,
  triggerClassName,
  title,
  align = 'left',
  wide = false,
  children,
}: {
  /** Accessible name of the trigger (and of the dialog). */
  triggerLabel: string
  triggerContent: ReactNode
  triggerClassName?: string
  title?: string
  align?: 'left' | 'right'
  wide?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <span className="anchored-popover" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={title ?? triggerLabel}
          tabIndex={-1}
          className={`anchored-popover__panel anchored-popover__panel--${align}${wide ? ' anchored-popover__panel--wide' : ''}`}
        >
          {title && <h3 className="anchored-popover__title">{title}</h3>}
          {children}
        </div>
      )}
    </span>
  )
}
