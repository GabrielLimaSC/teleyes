/**
 * S25-M1: motion for the whole app. One spring (the Feed's), a handful of
 * small tools:
 *
 * - `useSpringFollow(ref)`      a sticky rail that trails the scroll on a spring
 * - `<SwapTransition>`          directional slide + fade between tabs
 * - `useSegmentThumb(value)`    the indicator that glides between segments
 * - `usePresence` + `animateExit`/`animateEnter` + presets
 *                               animate a thing out before it unmounts
 * - `useModalMotion`            the same for modals mounted by their parent
 * - `staggerStyle(i)` + `.motion-item`   short cascade for arriving list items
 * - `enableRouteTransitions`    View Transitions for page navigation
 *
 * Rules: only `transform` and `opacity` move; `prefers-reduced-motion` turns
 * everything into an instant change or a short fade.
 */
export { CHROME_SPRING_EASING, CHROME_SPRING_MS } from './tokens'
export { useSpringFollow } from './useSpringFollow'
export { SwapTransition, swapDirection, useSwapDirection } from './SwapTransition'
export type { SwapDirection } from './SwapTransition'
export { useSegmentThumb } from './useSegmentThumb'
export { usePresence } from './usePresence'
export { useModalMotion } from './modalMotion'
export { BACKDROP_PRESET, DIALOG_PRESET, POPOVER_PRESET, SHEET_PRESET, animateEnter, animateExit, cancelExit } from './waapi'
export type { MotionPreset } from './waapi'
export { staggerStyle } from './stagger'
export { enableRouteTransitions } from './routeTransition'
