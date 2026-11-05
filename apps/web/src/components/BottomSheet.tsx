import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { CONFIRM_DIALOG_ATTR } from './ConfirmDialog'
import './BottomSheet.css'

const HISTORY_KEY = '__teleyesSheet'
let entryCounter = 0
const DISMISS_DISTANCE = 96
const DISMISS_VELOCITY = 0.6 // px per ms

export interface BottomSheetProps {
  open: boolean
  /** Called by every way of dismissing: the close button, backdrop, Esc, a
   * downward drag and the browser/phone back button. */
  onClose: () => void
  /** Visible heading and accessible name of the dialog. */
  title: string
  children: ReactNode
  /** Extra class on the panel (width/height tweaks of a specific sheet). */
  className?: string
}

/**
 * S24-01: reusable bottom sheet for the phone layout (menus, popovers, "Mais").
 *
 * `role="dialog"` + `aria-modal`, focus trapped inside and returned to the
 * opener on close. Opening pushes one history entry (same URL), so the back
 * button closes the sheet instead of leaving the page; closing any other way
 * pops that entry again. A link inside the sheet should use `replace`, so it
 * takes the sheet's entry and "back" returns to the page before the sheet.
 */
export function BottomSheet({ open, onClose, title, children, className }: BottomSheetProps) {
  if (!open) return null
  return createPortal(
    <SheetInner onClose={onClose} title={title} className={className}>
      {children}
    </SheetInner>,
    document.body,
  )
}

function SheetInner({
  onClose,
  title,
  className,
  children,
}: Pick<BottomSheetProps, 'onClose' | 'title' | 'className' | 'children'>) {
  const titleId = useId()
  const [entryId] = useState(() => `sheet-${++entryCounter}`)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const activeRef = useRef(false)
  const drag = useRef<{ startY: number; startAt: number; dy: number } | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useDialogFocus(panelRef)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // Back button: one history entry for the lifetime of the sheet. `entryId` is
  // stable across StrictMode's remount, so the entry is pushed only once.
  useEffect(() => {
    activeRef.current = true
    let popped = false
    if (window.history.state?.[HISTORY_KEY] !== entryId) {
      window.history.pushState({ ...window.history.state, [HISTORY_KEY]: entryId }, '')
    }
    const onPop = () => {
      popped = true
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      activeRef.current = false
      if (popped) return
      // Deferred: a StrictMode remount re-activates the sheet in the same tick.
      setTimeout(() => {
        if (!activeRef.current && window.history.state?.[HISTORY_KEY] === entryId) window.history.back()
      }, 0)
    }
  }, [entryId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector(`[${CONFIRM_DIALOG_ATTR}]`) !== null) return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [])

  const setOffset = (dy: number) => {
    const panel = panelRef.current
    if (panel === null) return
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''
    panel.style.transition = 'none'
  }

  const onDragStart = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button') !== null) return
    drag.current = { startY: event.clientY, startAt: event.timeStamp, dy: 0 }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onDragMove = (event: PointerEvent<HTMLElement>) => {
    if (drag.current === null) return
    drag.current.dy = Math.max(0, event.clientY - drag.current.startY)
    setOffset(drag.current.dy)
  }
  const onDragEnd = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current
    drag.current = null
    if (state === null) return
    const elapsed = Math.max(1, event.timeStamp - state.startAt)
    if (state.dy > DISMISS_DISTANCE || (state.dy > 24 && state.dy / elapsed > DISMISS_VELOCITY)) {
      onCloseRef.current()
      return
    }
    const panel = panelRef.current
    if (panel !== null) {
      panel.style.transition = ''
      panel.style.transform = ''
    }
  }

  return (
    <div
      className="bottom-sheet__backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bottom-sheet${className ? ` ${className}` : ''}`}
      >
        <div
          className="bottom-sheet__grab"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <span className="bottom-sheet__handle" aria-hidden="true" />
          <div className="bottom-sheet__header">
            <h2 id={titleId} className="bottom-sheet__title">
              {title}
            </h2>
            <button
              ref={closeRef}
              type="button"
              className="bottom-sheet__close"
              aria-label="Fechar"
              onClick={() => onCloseRef.current()}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>
        <div className="bottom-sheet__body">{children}</div>
      </div>
    </div>
  )
}
