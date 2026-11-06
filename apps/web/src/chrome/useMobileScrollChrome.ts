import { useEffect, useState } from 'react'

/**
 * S25-M2: scroll-driven chrome of the phone. Going down folds the tab bar to
 * icons; going up (or resting near the end of the page, or back at the top)
 * brings the labels back. The distances are the hysteresis: a jittery thumb
 * never flips the bar back and forth.
 */

const FOLD_AFTER = 96 // never fold while the page is this close to the top
const FOLD_DISTANCE = 18 // px travelled down before folding
const UNFOLD_DISTANCE = 10 // px travelled up before unfolding
const NEAR_END = 56 // px from the end of the page that count as "at the end"
const TOP_SCROLLED = 6

export interface MobileScrollState {
  compact: boolean
  scrolled: boolean
  /** Scroll position where the current direction started. */
  anchor: number
  lastY: number
}

export const INITIAL_MOBILE_SCROLL: MobileScrollState = { compact: false, scrolled: false, anchor: 0, lastY: 0 }

/** Pure step of the state machine: one scroll sample in, next state out. */
export function stepMobileScroll(
  state: MobileScrollState,
  y: number,
  viewport: number,
  documentHeight: number,
): MobileScrollState {
  const position = Math.max(0, y)
  const scrolled = position > TOP_SCROLLED
  const goingDown = position > state.lastY
  const goingUp = position < state.lastY
  // A change of direction restarts the distance count.
  const turned = (goingDown && state.lastY < state.anchor) || (goingUp && state.lastY > state.anchor)
  const anchor = turned ? state.lastY : state.anchor
  const nearEnd = position + viewport >= documentHeight - NEAR_END
  let compact = state.compact
  if (position <= TOP_SCROLLED || nearEnd) compact = false
  else if (!compact && goingDown && position > FOLD_AFTER && position - anchor >= FOLD_DISTANCE) compact = true
  else if (compact && goingUp && anchor - position >= UNFOLD_DISTANCE) compact = false
  return { compact, scrolled, anchor: compact !== state.compact ? position : anchor, lastY: position }
}

export function useMobileScrollChrome(): { compact: boolean; scrolled: boolean } {
  const [view, setView] = useState({ compact: false, scrolled: false })

  useEffect(() => {
    let state: MobileScrollState = { ...INITIAL_MOBILE_SCROLL, lastY: window.scrollY, anchor: window.scrollY }
    let frame = 0
    const sample = () => {
      frame = 0
      state = stepMobileScroll(state, window.scrollY, window.innerHeight, document.documentElement.scrollHeight)
      setView((previous) =>
        previous.compact === state.compact && previous.scrolled === state.scrolled
          ? previous
          : { compact: state.compact, scrolled: state.scrolled },
      )
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(sample)
    }
    sample()
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      window.removeEventListener('scroll', schedule)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [])

  return view
}
