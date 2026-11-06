import {
  CHROME_SPRING_EASING,
  ENTER_MS,
  EXIT_EASING,
  EXIT_MS,
  REDUCED_FADE_MS,
  SHEET_ENTER_MS,
  prefersReducedMotion,
  supportsWaapi,
} from './tokens'

/**
 * S25-M1: entrance / exit helpers on top of the Web Animations API.
 *
 * - Only `transform` and `opacity` are ever animated (compositor-only).
 * - Nothing is left inline when an entrance ends; an exit keeps its last
 *   frame (`fill: forwards`) so the element never flashes back before React
 *   (or the caller) removes it.
 * - `prefers-reduced-motion`: a short fade instead of the movement.
 * - No WAAPI (jsdom, very old browsers): the entrance is skipped and the exit
 *   resolves at once, so nothing waits for an animation that cannot run.
 */

export const EXIT_ANIMATION_ID = 'motion-exit'

export interface MotionPreset {
  /** Plays when the element appears. */
  enter: Keyframe[]
  /** Plays when it leaves. */
  exit: Keyframe[]
  enterMs?: number
  exitMs?: number
}

/** Dim layer behind a dialog or sheet. */
export const BACKDROP_PRESET: MotionPreset = {
  enter: [{ opacity: 0 }, { opacity: 1 }],
  exit: [{ opacity: 1 }, { opacity: 0 }],
  enterMs: 220,
  exitMs: EXIT_MS,
}

/** Modal dialog: scale 0.96 → 1 and fade. */
export const DIALOG_PRESET: MotionPreset = {
  enter: [
    { opacity: 0, transform: 'scale(0.96)' },
    { opacity: 1, transform: 'scale(1)' },
  ],
  exit: [
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0, transform: 'scale(0.97)' },
  ],
  enterMs: ENTER_MS,
}

/** Bottom sheet panel: rises from below the viewport edge. */
export const SHEET_PRESET: MotionPreset = {
  enter: [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
  exit: [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
  enterMs: SHEET_ENTER_MS,
  exitMs: 240,
}

/** Popover / menu: grows from the trigger (set `transform-origin` first). */
export const POPOVER_PRESET: MotionPreset = {
  enter: [
    { opacity: 0, transform: 'scale(0.94)' },
    { opacity: 1, transform: 'scale(1)' },
  ],
  exit: [
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0, transform: 'scale(0.96)' },
  ],
  enterMs: 320,
  exitMs: 140,
}

const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }]

/** Replaces the first keyframe's `transform` (a sheet released mid-drag
 * springs back from where the finger left it). */
function withStart(frames: Keyframe[], from: string | undefined): Keyframe[] {
  return from === undefined ? frames : [{ ...frames[0], transform: from }, ...frames.slice(1)]
}

/** Plays the entrance of `element`; returns the animation, or null when none
 * can run (no WAAPI). */
export function animateEnter(element: HTMLElement, preset: MotionPreset, from?: string): Animation | null {
  if (!supportsWaapi()) return null
  if (prefersReducedMotion()) return element.animate(FADE_IN, { duration: REDUCED_FADE_MS, easing: 'ease-out' })
  return element.animate(withStart(preset.enter, from), {
    duration: preset.enterMs ?? ENTER_MS,
    easing: CHROME_SPRING_EASING,
  })
}

/** Plays the exit of `element` and resolves when it ends (at once when WAAPI
 * is unavailable or the animation is cancelled). */
export function animateExit(element: HTMLElement, preset: MotionPreset, from?: string): Promise<void> {
  if (!supportsWaapi()) return Promise.resolve()
  const reduced = prefersReducedMotion()
  const animation = element.animate(reduced ? FADE_OUT : withStart(preset.exit, from), {
    duration: reduced ? REDUCED_FADE_MS : (preset.exitMs ?? EXIT_MS),
    easing: reduced ? 'ease-in' : EXIT_EASING,
    fill: 'forwards',
  })
  animation.id = EXIT_ANIMATION_ID
  return animation.finished.then(
    () => undefined,
    () => undefined,
  )
}

/** Cancels an exit that is still running (the thing was reopened). */
export function cancelExit(element: HTMLElement | null): void {
  if (element === null || typeof element.getAnimations !== 'function') return
  for (const animation of element.getAnimations()) {
    if (animation.id === EXIT_ANIMATION_ID) animation.cancel()
  }
}
