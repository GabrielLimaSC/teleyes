import { CHROME_SPRING_EASING, CHROME_SPRING_MS, prefersReducedMotion } from '../chrome/scrollChrome'

/**
 * S25-M1: the one vocabulary of motion for the whole app. Everything here
 * reuses the Feed's chrome spring (`CHROME_SPRING_EASING`, an underdamped
 * ζ≈0.72 curve sampled into `linear()`), only run for shorter durations: the
 * curve is the same, so a sheet, a tab and a rail all "feel" like the Feed.
 */
export { CHROME_SPRING_EASING, CHROME_SPRING_MS, prefersReducedMotion }

/** Springs for things that appear (dialogs, popovers, swapped content). */
export const ENTER_MS = 380
export const SHEET_ENTER_MS = 460
/** Exits are quick and never overshoot: the thing is already leaving. */
export const EXIT_MS = 180
export const EXIT_EASING = 'cubic-bezier(0.4, 0, 0.9, 0.6)'
/** Reduced motion keeps only a short fade (or nothing, for lists and swaps). */
export const REDUCED_FADE_MS = 100

/** Short slide used by `SwapTransition`, in px (the brief's 12–24 range). */
export const SWAP_DISTANCE = 16

/** True when the browser can run WAAPI animations (jsdom cannot). */
export function supportsWaapi(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}
