/** Single source of truth for the `prefers-reduced-motion` check, used to skip
 * JS-driven motion (View Transitions, click-origin fill) — CSS-only motion
 * (the pill slide, button fill transition) is guarded directly in CSS via the
 * same media query, so both paths agree without duplicating the condition. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
