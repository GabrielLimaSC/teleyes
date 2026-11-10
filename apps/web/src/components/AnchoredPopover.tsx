import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { POPOVER_PRESET, animateEnter, animateExit } from '../motion/waapi'
import { usePresence } from '../motion/usePresence'
import { BottomSheet } from './BottomSheet'
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
  const phone = useMediaQuery(PHONE_QUERY)
  const showPanel = open && !phone
  // S25-M1: the panel grows from the trigger and shrinks back into it.
  const rendered = usePresence(showPanel, panelRef, (panel) => animateExit(panel, POPOVER_PRESET))

  useLayoutEffect(() => {
    const panel = panelRef.current
    const trigger = triggerRef.current
    if (!showPanel || panel === null || trigger === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    panel.style.transformOrigin = `${anchor.left + anchor.width / 2 - box.left}px 0`
    animateEnter(panel, POPOVER_PRESET)
  }, [showPanel])

  useEffect(() => {
    if (!open || phone) return
    panelRef.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, phone])

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
      {phone && (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={title ?? triggerLabel}>
          {children}
        </BottomSheet>
      )}
      {rendered && (
        <div
          ref={panelRef}
          inert={!showPanel}
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
