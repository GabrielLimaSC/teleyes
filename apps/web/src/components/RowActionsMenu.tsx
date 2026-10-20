import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import './RowActionsMenu.css'

export interface RowActionsMenuItem {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Draws a divider above this item. */
  separatorBefore?: boolean
}

interface MenuPosition {
  top: number
  left: number
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 4

/**
 * S18-01: overflow ("⋯") menu for a table row's secondary actions.
 *
 * The panel is rendered in a portal on `document.body` with fixed positioning,
 * so the table container's `overflow` can never clip it (last row included).
 * Closes on outside click, Escape and Tab; follows the trigger on scroll and resize; Escape and a
 * selection return focus to the trigger. Arrow keys / Home / End move between
 * items (roving focus).
 */
export function RowActionsMenu({
  label,
  items,
}: {
  label: string
  items: RowActionsMenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Right-aligned under the trigger; clamped into the viewport horizontally
  // (a phone card puts the trigger near the left edge) and flipped above the
  // trigger when there is no room below (last row of a tall page).
  const place = useCallback(() => {
    if (triggerRef.current === null || menuRef.current === null) return
    const rect = triggerRef.current.getBoundingClientRect()
    const { offsetWidth, offsetHeight } = menuRef.current
    const maxLeft = window.innerWidth - offsetWidth - VIEWPORT_MARGIN
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - offsetWidth, maxLeft))
    const below = rect.bottom + MENU_GAP
    const fitsBelow = below + offsetHeight <= window.innerHeight - VIEWPORT_MARGIN
    const top = fitsBelow ? below : Math.max(VIEWPORT_MARGIN, rect.top - MENU_GAP - offsetHeight)
    setPosition({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  const focusItem = useCallback((index: number) => {
    const nodes = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    if (!nodes || nodes.length === 0) return
    nodes[(index + nodes.length) % nodes.length]?.focus()
  }, [])

  useEffect(() => {
    if (!open || position === null) return
    focusItem(0)
  }, [open, position, focusItem])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    const onViewportChange = () => place()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, close, place])

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    )
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusItem(current + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusItem(current - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusItem(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusItem(nodes.length - 1)
    } else if (event.key === 'Tab') {
      close(true)
    }
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="plane-action plane-action--secondary plane-action--compact row-actions__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="row-actions__menu"
            style={
              position === null
                ? { visibility: 'hidden' }
                : { top: position.top, left: position.left }
            }
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => (
              <div key={item.key} role="none">
                {item.separatorBefore && <div className="row-actions__divider" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`row-actions__item${item.danger ? ' row-actions__item--danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    close(true)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
