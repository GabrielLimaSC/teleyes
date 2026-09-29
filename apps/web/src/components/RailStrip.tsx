import type { CSSProperties } from 'react'

/**
 * S15-03: the collapsed face of a Feed side rail while the page is scrolled —
 * one icon per section of the rail. It lives inside the rail itself (the
 * same glass box morphs between its two faces, FeedPage.css), and each icon
 * reopens the rail at its own section; the rail then takes its column back
 * from the feed instead of opening on top of it.
 */

export type RailIconName = 'target' | 'snooze' | 'filter' | 'sources' | 'summary' | 'digest' | 'today'

export interface RailStripItem {
  sectionId: string
  label: string
  icon: RailIconName
  /** Small dot: the section holds something worth noticing (an active
   * filter, a snoozed item). */
  flagged?: boolean
}

const PATHS: Record<RailIconName, string[]> = {
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  snooze: ['M6 8a6 6 0 0 1 9.3-5', 'M18 8.5c0 5.5 2 7.5 2 7.5H4s2-2 2-7.5', 'M10.3 20a1.9 1.9 0 0 0 3.4 0', 'M3 3l18 18'],
  filter: ['M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z'],
  sources: ['M4.9 19.1a10 10 0 0 1 0-14.2', 'M19.1 4.9a10 10 0 0 1 0 14.2', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  summary: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  digest: ['M4 5h16v14H4z', 'M4 7l8 6 8-6'],
  today: ['M4 6h16v15H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4', 'M9 15h2'],
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
        <button
          key={item.sectionId}
          type="button"
          className="rail-strip__button"
          aria-label={item.label}
          aria-controls={controls}
          aria-expanded={false}
          title={item.label}
          onClick={() => onOpen(item.sectionId)}
          style={{ '--rail-stagger': index + 1 } as CSSProperties}
        >
          <RailIcon name={item.icon} />
          {item.flagged && <span className="rail-strip__flag" aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}
