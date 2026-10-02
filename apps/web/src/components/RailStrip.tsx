import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { createPortal } from 'react-dom'
import './GlassCard.css'

/**
 * S15-03: the collapsed face of a Feed side rail while the page is scrolled —
 * one icon per section of the rail. It lives inside the rail itself (the
 * same glass box morphs between its two faces, FeedPage.css), and each icon
 * reopens the rail at its own section; the rail then takes its column back
 * from the feed instead of opening on top of it.
 *
 * S16-02: each button can also carry a numeric badge (only shown above 0,
 * e.g. "2 alvos ativos") and a glass tooltip with a label + live context
 * (e.g. "Alvos de preço · 2 ativos, o mais perto falta 7%") — the rail keeps
 * informing even collapsed to a 64px strip.
 */

export type RailIconName = 'target' | 'snooze' | 'filter' | 'sources' | 'summary' | 'send' | 'digest'

export interface RailStripItem {
  /** Only needed when two items share the same `sectionId` (the right
   * rail's "Matches"/"Enviados" icons both open "Resumo") — used as the
   * React key instead. */
  id?: string
  sectionId: string
  label: string
  icon: RailIconName
  /** Small dot: the section holds something worth noticing (an active
   * filter, a snoozed item) but has no number worth a badge. */
  flagged?: boolean
  /** Numeric badge, shown only when > 0 (the design's own rule) — folded
   * into the button's accessible name too, so a screen reader hears the
   * count, not just an icon. */
  badge?: number
  /** Glass tooltip text ("rótulo · contexto"), shown on hover AND keyboard
   * focus — rendered through a portal (below) so the rail's own
   * `overflow: hidden` while collapsed/springing never clips it. */
  tooltip?: string
}

const PATHS: Record<RailIconName, string[]> = {
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  snooze: ['M6 8a6 6 0 0 1 9.3-5', 'M18 8.5c0 5.5 2 7.5 2 7.5H4s2-2 2-7.5', 'M10.3 20a1.9 1.9 0 0 0 3.4 0', 'M3 3l18 18'],
  filter: ['M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z'],
  sources: ['M4.9 19.1a10 10 0 0 1 0-14.2', 'M19.1 4.9a10 10 0 0 1 0 14.2', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  summary: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  send: ['M22 2 11 13', 'm22 2-7 20-4-9-9-4Z'],
  digest: ['M4 5h16v14H4z', 'M4 7l8 6 8-6'],
}

export function RailIcon({ name }: { name: RailIconName }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="rail-strip__icon">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export function RailChevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="rail-strip__icon">
      <path d={direction === 'right' ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} />
    </svg>
  )
}

/** S16-02: positions a glass bubble at a fixed viewport coordinate measured
 * from the trigger button — a portal to `document.body`, so no ancestor's
 * `overflow: hidden` (the rail while collapsed/springing, FeedPage.css) ever
 * clips it, and it never permanently covers a card since it only mounts
 * while `visible`. */
function RailTooltipBubble({
  anchorRef,
  side,
  text,
  visible,
  id,
}: {
  anchorRef: RefObject<HTMLElement | null>
  side: 'left' | 'right'
  text: string
  visible: boolean
  id: string
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null)
      return
    }
    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const box = anchor.getBoundingClientRect()
      setPosition({
        top: box.top + box.height / 2,
        left: side === 'left' ? box.right + 10 : box.left - 10,
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible, side, anchorRef])

  if (!visible || position === null || typeof document === 'undefined') return null

  return createPortal(
    <span
      role="tooltip"
      id={id}
      className="glass-card rail-strip__tooltip"
      style={{
        top: position.top,
        left: position.left,
        transform: side === 'left' ? 'translateY(-50%)' : 'translate(-100%, -50%)',
      }}
    >
      {text}
    </span>,
    document.body,
  )
}

function RailStripButton({
  item,
  controls,
  onOpen,
  side,
  index,
}: {
  item: RailStripItem
  controls: string
  onOpen: (sectionId?: string) => void
  side: 'left' | 'right'
  index: number
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tooltipId = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const showTooltip = Boolean(item.tooltip) && (hovered || focused)
  const hasBadge = Boolean(item.badge && item.badge > 0)
  const ariaLabel = hasBadge ? `${item.label} · ${item.badge}` : item.label

  return (
    <button
      ref={buttonRef}
      type="button"
      className="rail-strip__button"
      aria-label={ariaLabel}
      aria-controls={controls}
      aria-expanded={false}
      aria-describedby={item.tooltip ? tooltipId : undefined}
      onClick={() => onOpen(item.sectionId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ '--rail-stagger': index + 1 } as CSSProperties}
    >
      <RailIcon name={item.icon} />
      {item.flagged && <span className="rail-strip__flag" aria-hidden="true" />}
      {hasBadge && (
        <span className="rail-strip__badge" aria-hidden="true">
          {item.badge}
        </span>
      )}
      {item.tooltip && (
        <RailTooltipBubble anchorRef={buttonRef} side={side} text={item.tooltip} visible={showTooltip} id={tooltipId} />
      )}
    </button>
  )
}

export function RailStrip({
  className,
  side,
  items,
  controls,
  onOpen,
}: {
  className?: string
  side: 'left' | 'right'
  items: RailStripItem[]
  /** id of the rail this strip expands (`aria-controls`). */
  controls: string
  onOpen: (sectionId?: string) => void
}) {
  return (
    <div className={'rail-strip' + (className ? ` ${className}` : '')}>
      <button
        type="button"
        className="rail-strip__button rail-strip__button--toggle"
        aria-label="Expandir painel"
        aria-controls={controls}
        aria-expanded={false}
        title="Expandir painel"
        onClick={() => onOpen()}
        style={{ '--rail-stagger': 0 } as CSSProperties}
      >
        <RailChevron direction={side === 'left' ? 'right' : 'left'} />
      </button>
      {items.map((item, index) => (
        <RailStripButton key={item.id ?? item.sectionId} item={item} controls={controls} onOpen={onOpen} side={side} index={index} />
      ))}
    </div>
  )
}
