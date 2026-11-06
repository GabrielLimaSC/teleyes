import { useState } from 'react'
import type { CSSProperties } from 'react'

/** Only the first items of a list animate: the rest are off-screen anyway. */
const ARRIVAL_LIMIT = 12

/**
 * S25-M1: list cascade. An item that ARRIVES (a row mounted by a load, a
 * filter change or a new record) gets `className="motion-item"` and
 * `style={staggerStyle(index)}`: it rises 8 px and fades in, 30 ms after the
 * previous one, for the first four positions (so a whole list lands within
 * 300 ms, however long it is — see `.motion-item` in motion.css).
 *
 * Items that keep their React key never replay. Inline `.map()` lists use
 * `staggerClass(index)` / `staggerStyle(index)`; a row that is its own
 * component uses `useArrival(index)`, which reads the index only at mount, so
 * a row that merely moves in the list never blinks.
 */
export function staggerStyle(index: number): CSSProperties {
  return { '--motion-i': index } as CSSProperties
}

export function staggerClass(index: number): string {
  return index >= 0 && index < ARRIVAL_LIMIT ? 'motion-item' : ''
}

export function useArrival(index: number): { className: string; style: CSSProperties | undefined } {
  const [arrival] = useState(() =>
    staggerClass(index) === '' ? { className: '', style: undefined } : { className: 'motion-item', style: staggerStyle(index) },
  )
  return arrival
}
