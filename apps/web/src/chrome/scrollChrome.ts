import { useEffect, useSyncExternalStore } from 'react'

/**
 * S15-03: the Feed's scroll-driven "compact chrome". One tiny store shared by
 * the page that owns the scroll behaviour (FeedPage) and the app-level chrome
 * that reacts to it (NavCapsule), plus `<html data-chrome>` so plain CSS can
 * react too:
 *
 * - no attribute: every other page, and the Feed below the wide breakpoint —
 *   nothing changes there;
 * - `rest`: Feed at the top — the normal layout, with the capsule already
 *   `position: fixed` in its usual spot (so the switch to compact never has
 *   to change its positioning scheme mid-scroll);
 * - `compact`: Feed scrolled past its header.
 *
 * Hysteresis (enter well past the header, leave only near the very top) so a
 * scroll position near one threshold never flickers between the two states.
 */

export type ChromeMode = 'off' | 'rest' | 'compact'

export const CHROME_MEDIA_QUERY = '(min-width: 1101px)'
const ENTER_COMPACT_AT = 140
const LEAVE_COMPACT_AT = 24

let mode: ChromeMode = 'off'
const listeners = new Set<() => void>()
const flipElements = new Set<HTMLElement>()
const beforeChange = new Set<() => void>()
let animatingTimer = 0

function setMode(next: ChromeMode) {
  if (next === mode) return
  const animate = mode !== 'off' && next !== 'off' && !prefersReducedMotion()
  const firsts = animate ? [...flipElements].map((element) => [element, element.getBoundingClientRect()] as const) : []
  if (animate) beforeChange.forEach((callback) => callback())

  mode = next
  const root = document.documentElement
  if (next === 'off') delete root.dataset.chrome
  else root.dataset.chrome = next
  // Transitions that only belong to a mode switch (not to a resize) key off
  // this, for the length of one spring.
  if (animate) markChromeAnimating()
  else {
    window.clearTimeout(animatingTimer)
    delete root.dataset.chromeAnimating
  }

  // FLIP: an element whose box the attribute just moved (the Feed controls,
  // docked into the top band) starts drawn where it was and springs to its
  // new place — the same element travelling, never a jump or a copy.
  for (const [element, first] of firsts) {
    const last = element.getBoundingClientRect()
    const dx = first.left - last.left
    const dy = first.top - last.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    element.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
      duration: CHROME_SPRING_MS,
      easing: CHROME_SPRING_EASING,
    })
  }
  listeners.forEach((listener) => listener())
}

/** Sets `html[data-chrome-animating]` for one spring: the CSS that only
 * belongs to a moving layout (mode-switch transitions, skipping off-screen
 * cards) keys off it. Also called by the page when a rail opens/closes. */
export function markChromeAnimating(): void {
  const root = document.documentElement
  window.clearTimeout(animatingTimer)
  root.dataset.chromeAnimating = ''
  animatingTimer = window.setTimeout(() => delete root.dataset.chromeAnimating, CHROME_SPRING_MS + 120)
}

/** Registers an element whose position the compact chrome changes, so it
 * travels between its two places instead of jumping (see `setMode`). */
export function registerChromeFlip(element: HTMLElement): () => void {
  flipElements.add(element)
  return () => {
    flipElements.delete(element)
  }
}

/** Runs right before the mode changes (not on/off) — the page uses it to
 * start its scroll anchor before the layout moves. */
export function onBeforeChromeChange(callback: () => void): () => void {
  beforeChange.add(callback)
  return () => {
    beforeChange.delete(callback)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useChromeMode(): ChromeMode {
  return useSyncExternalStore(subscribe, () => mode, () => 'off')
}

/** Next mode for a scroll position, given the current one (the hysteresis). */
export function nextChromeMode(current: ChromeMode, scrollY: number): ChromeMode {
  if (current === 'compact') return scrollY < LEAVE_COMPACT_AT ? 'rest' : 'compact'
  return scrollY > ENTER_COMPACT_AT ? 'compact' : 'rest'
}

/** Owned by the page (FeedPage): turns the compact chrome on while mounted
 * and wide enough, and keeps its mode in sync with the window scroll. */
export function useScrollChrome(enabled: boolean): ChromeMode {
  useEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(CHROME_MEDIA_QUERY)
    let frame = 0

    const update = () => {
      frame = 0
      setMode(media.matches ? nextChromeMode(mode === 'off' ? 'rest' : mode, window.scrollY) : 'off')
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }

    update()
    window.addEventListener('scroll', schedule, { passive: true })
    media.addEventListener('change', update)
    return () => {
      window.removeEventListener('scroll', schedule)
      media.removeEventListener('change', update)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      setMode('off')
    }
  }, [enabled])

  return useChromeMode()
}

/** The short spring the whole compact chrome moves on (mirrors
 * `--chrome-spring` in styles/chrome.css — WAAPI can't read a CSS variable).
 * Underdamped, ζ≈0.72: ~4% overshoot, then settles. */
export const CHROME_SPRING_EASING =
  'linear(0, 0.0265, 0.094, 0.1868, 0.2929, 0.4029, 0.5102, 0.6102, 0.7001, 0.7783, 0.8445, 0.8988, 0.942, 0.9754, 1, 1.0174, 1.0287, 1.0353, 1.0381, 1.0382, 1.0363, 1.0332, 1.0293, 1.0251, 1.0209, 1.0169, 1.0133, 1.01, 1.0072, 1.0049, 1.003, 1.0016, 1.0005, 0.9996, 0.9991, 0.9988, 1)'
export const CHROME_SPRING_MS = 680

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Keeps the first card on screen visually still while the layout above/around
 * it animates (rails collapsing/expanding re-flow every card) — a manual
 * scroll anchor for the length of the spring, because Safari has no native
 * `overflow-anchor` and Chrome's would fight this one (`styles/chrome.css`
 * turns the native one off while the chrome is active).
 */
export function anchorScrollDuring(selector: string, durationMs: number): void {
  const viewportTop = 110
  const anchor = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.getBoundingClientRect().bottom > viewportTop,
  )
  if (!anchor) return
  // Document position, not viewport position: only a layout shift moves it,
  // so the user's own scrolling during the spring is never fought back.
  const documentTop = () => anchor.getBoundingClientRect().top + window.scrollY
  let lastTop = documentTop()
  const until = performance.now() + durationMs
  const step = () => {
    const top = documentTop()
    const shift = top - lastTop
    if (Math.abs(shift) > 0.5) window.scrollBy(0, shift)
    lastTop = top
    if (performance.now() < until) window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
}
