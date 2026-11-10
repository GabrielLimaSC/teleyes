import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { PHONE_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { POPOVER_PRESET, animateEnter, animateExit } from '../motion/waapi'
import { usePresence } from '../motion/usePresence'
import { BottomSheet } from './BottomSheet'
import './RowActionsMenu.css'

export interface RowActionsMenuItem {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Draws a divider above this item. */
  separatorBefore?: boolean
  /** S25-F4: a submenu. Selecting the item opens its choices (inline on the
   * desktop, as a second step in the phone sheet) instead of calling `onSelect`. */
  children?: RowActionsMenuItem[]
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
  // The key of the item whose submenu is open (desktop: inline; phone: second step).
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const phone = useMediaQuery(PHONE_QUERY)
  const phoneParent = phone ? items.find((item) => item.key === expandedKey && item.children) : undefined
  const showMenu = open && !phone
  // S25-M1: grows from the trigger, shrinks back into it.
  const rendered = usePresence(showMenu, menuRef, (menu) => animateExit(menu, POPOVER_PRESET))

  const openMenu = useCallback(() => {
    setPosition(null)
    setOpen(true)
  }, [])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setExpandedKey(null)
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
    if (open && !phone) place()
  }, [open, phone, place, expandedKey])

  const placed = position !== null
  useLayoutEffect(() => {
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!showMenu || !placed || menu === null || trigger === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    const originY = anchor.top > box.top ? box.height : 0
    menu.style.transformOrigin = `${anchor.left + anchor.width / 2 - box.left}px ${originY}px`
    animateEnter(menu, POPOVER_PRESET)
  }, [showMenu, placed])

  const focusItem = useCallback((index: number) => {
    const nodes = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    if (!nodes || nodes.length === 0) return
    nodes[(index + nodes.length) % nodes.length]?.focus()
  }, [])

  useEffect(() => {
    if (!open || phone || position === null) return
    focusItem(0)
  }, [open, phone, position, focusItem])

  useEffect(() => {
    if (expandedKey === null || phone) return
    menuRef.current?.querySelector<HTMLButtonElement>('[data-submenu] [role="menuitem"]:not(:disabled)')?.focus()
  }, [expandedKey, phone])

  useEffect(() => {
    if (!open || phone) return
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
  }, [open, phone, close, place])

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
    } else if (event.key === 'ArrowRight') {
      const parent = items.find((item) => item.children && item.key === focusedKey(current, nodes))
      if (parent && expandedKey !== parent.key) {
        event.preventDefault()
        setExpandedKey(parent.key)
      }
    } else if (event.key === 'ArrowLeft' && expandedKey !== null) {
      event.preventDefault()
      const parentKey = expandedKey
      setExpandedKey(null)
      requestAnimationFrame(() =>
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-item-key="${parentKey}"]`)?.focus(),
      )
    } else if (event.key === 'Tab') {
      close(true)
    }
  }

  const focusedKey = (index: number, nodes: HTMLButtonElement[]): string | null =>
    index < 0 ? null : (nodes[index]?.dataset.itemKey ?? null)

  const choose = (item: RowActionsMenuItem) => {
    if (item.children) {
      setExpandedKey(expandedKey === item.key ? null : item.key)
      return
    }
    close(true)
    item.onSelect()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault()
      openMenu()
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
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {phone && (
        <BottomSheet open={open} onClose={() => close(false)} title={phoneParent?.label ?? label}>
          <div className="bottom-sheet__list" role="menu" aria-label={phoneParent?.label ?? label}>
            {phoneParent && (
              <button
                type="button"
                role="menuitem"
                className="bottom-sheet__item bottom-sheet__item--back"
                onClick={() => setExpandedKey(null)}
              >
                <span aria-hidden="true">‹</span> Voltar
              </button>
            )}
            {(phoneParent?.children ?? items).map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`bottom-sheet__item${item.danger ? ' bottom-sheet__item--danger' : ''}`}
                disabled={item.disabled}
                aria-haspopup={item.children ? 'menu' : undefined}
                onClick={() => {
                  if (item.children) {
                    setExpandedKey(item.key)
                    return
                  }
                  close(false)
                  item.onSelect()
                }}
              >
                {item.label}
                {item.children && (
                  <span className="bottom-sheet__chevron" aria-hidden="true">
                    ›
                  </span>
                )}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
      {rendered &&
        createPortal(
          <div
            ref={menuRef}
            inert={!showMenu}
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
                  data-item-key={item.key}
                  className={`row-actions__item${item.danger ? ' row-actions__item--danger' : ''}`}
                  disabled={item.disabled}
                  aria-haspopup={item.children ? 'menu' : undefined}
                  aria-expanded={item.children ? expandedKey === item.key : undefined}
                  onClick={() => choose(item)}
                >
                  {item.label}
                  {item.children && (
                    <span className="row-actions__chevron" data-open={expandedKey === item.key || undefined} aria-hidden="true">
                      ›
                    </span>
                  )}
                </button>
                {item.children && expandedKey === item.key && (
                  <div className="row-actions__submenu" role="group" aria-label={item.label} data-submenu>
                    {item.children.map((child) => (
                      <button
                        key={child.key}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        data-item-key={child.key}
                        className="row-actions__item"
                        disabled={child.disabled}
                        onClick={() => choose(child)}
                      >
                        {child.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
