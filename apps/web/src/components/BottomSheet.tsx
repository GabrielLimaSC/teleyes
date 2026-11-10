import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { BACKDROP_PRESET, SHEET_PRESET, animateEnter, animateExit } from '../motion/waapi'
import { usePresence } from '../motion/usePresence'
import { prefersReducedMotion } from '../motion/tokens'
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
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // How far a drag left the panel below its place: the exit starts from there.
  const dragOffset = useRef(0)
  // S25-M1: closing keeps the sheet mounted while it sinks and the backdrop fades.
  const rendered = usePresence(open, backdropRef, (backdrop) => {
    const panel = panelRef.current
    const from = dragOffset.current > 0 ? `translateY(${dragOffset.current}px)` : undefined
    return Promise.all([
      animateExit(backdrop, BACKDROP_PRESET),
      panel === null ? Promise.resolve() : animateExit(panel, SHEET_PRESET, from),
    ]).then(() => undefined)
  })
  if (!rendered) return null
  return createPortal(
    <SheetInner
      open={open}
      backdropRef={backdropRef}
      panelRef={panelRef}
      dragOffset={dragOffset}
      onClose={onClose}
      title={title}
      className={className}
    >
      {children}
    </SheetInner>,
    document.body,
  )
}

function SheetInner({
  open,
  backdropRef,
  panelRef,
  dragOffset,
  onClose,
  title,
  className,
  children,
}: Pick<BottomSheetProps, 'open' | 'onClose' | 'title' | 'className' | 'children'> & {
  backdropRef: RefObject<HTMLDivElement | null>
  panelRef: RefObject<HTMLDivElement | null>
  dragOffset: RefObject<number>
}) {
  const titleId = useId()
  const [entryId] = useState(() => `sheet-${++entryCounter}`)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const activeRef = useRef(false)
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ startY: number; startAt: number; dy: number } | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  // `open` is false while the exit animation runs: focus goes back to the
  // opener, the history entry pops and the page scrolls again right away.
  useDialogFocus(panelRef, open)

  // S25-M1: the backdrop fades in and the panel rises on the Feed's spring.
  useLayoutEffect(() => {
    dragOffset.current = 0
    if (backdropRef.current !== null) animateEnter(backdropRef.current, BACKDROP_PRESET)
    if (panelRef.current !== null) animateEnter(panelRef.current, SHEET_PRESET)
  }, [backdropRef, panelRef, dragOffset])

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // Back button: one history entry for the lifetime of the sheet. `entryId` is
  // stable across StrictMode's remount, so the entry is pushed only once.
  useEffect(() => {
    if (!open) return
    // A remount (StrictMode) re-activates the sheet in the same tick: the pop
    // its cleanup scheduled must not run. Checking `activeRef` when the timer
    // fires is not enough: if the sheet is really closed before a late timer
    // runs, both timers see it inactive and each call `history.back()`, which
    // goes one entry past the sheet's own (to the page before Regras).
    if (popTimer.current !== null) {
      clearTimeout(popTimer.current)
      popTimer.current = null
    }
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
      // Deferred, and at most one pending pop per sheet.
      if (popTimer.current !== null) clearTimeout(popTimer.current)
      popTimer.current = setTimeout(() => {
        popTimer.current = null
        if (!activeRef.current && window.history.state?.[HISTORY_KEY] === entryId) window.history.back()
      }, 0)
    }
  }, [entryId, open])

  useEffect(() => {
    if (!open) return
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
  }, [open])

  const setOffset = (dy: number) => {
    const panel = panelRef.current
    if (panel === null) return
    dragOffset.current = dy
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''
  }

  const onDragStart = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button') !== null) return
    // The finger takes over from the entrance spring.
    panelRef.current?.getAnimations?.().forEach((animation) => animation.cancel())
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
    // Released short of the threshold: spring back from where the finger left it.
    const panel = panelRef.current
    const from = `translateY(${state.dy}px)`
    dragOffset.current = 0
    if (panel === null) return
    panel.style.transform = ''
    if (state.dy > 0 && !prefersReducedMotion()) animateEnter(panel, SHEET_PRESET, from)
  }

  return (
    <div
      ref={backdropRef}
      className="bottom-sheet__backdrop"
      role="presentation"
      inert={!open}
      onPointerDown={(event) => {
        if (open && event.target === event.currentTarget) onCloseRef.current()
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
