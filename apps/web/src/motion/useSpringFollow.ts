import { useEffect } from 'react'
import type { RefObject } from 'react'
import { PHONE_QUERY, useMediaQuery, usePrefersReducedMotion } from '../hooks/useMediaQuery'
import { isSettled, springStep } from './spring'

/** Stiffness of the follow: settles in ~400 ms, like the Feed's chrome spring. */
const FOLLOW_OMEGA = 14
/** However hard the page is flung, the rail never trails by more than this. */
const MAX_LAG_PX = 140
/** Longest frame the integrator accepts (a throttled tab must not teleport). */
const MAX_DT = 1 / 30

/**
 * S25-M1: a side rail that follows the scroll on a spring instead of being
 * glued to it.
 *
 * The rail keeps its native `position: sticky` (that decides WHERE it should
 * be, and is the whole behaviour without JS / with reduced motion). This hook
 * only adds a `translateY` on top: when the page scrolls, the sticky target
 * moves with it, the rail is left behind by that distance and a critically
 * damped spring pulls it back to the target. So it trails the scroll and
 * settles instead of being rigid.
 *
 * - `transform` only; geometry is read once per frame, never written.
 * - The loop runs only while there is something to settle; `will-change` and
 *   the inline transform are removed at rest (a leftover transform would turn
 *   the rail into a containing block for fixed descendants).
 * - Off on the phone layout and under `prefers-reduced-motion`.
 * - The offset never carries the rail out of its container.
 *
 * Use on the element that is `position: sticky`.
 */
export function useSpringFollow(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const phone = useMediaQuery(PHONE_QUERY)
  const reduced = usePrefersReducedMotion()
  const active = enabled && !phone && !reduced

  useEffect(() => {
    const element = ref.current
    if (!active || element === null) return

    let offset = 0
    let velocity = 0
    let frame = 0
    let lastTime = 0
    // Page-space top of the place the sticky rail WANTS to be (its position
    // with our own transform taken out).
    const stickyTop = () => element.getBoundingClientRect().top - offset + window.scrollY
    let previousTop = stickyTop()

    const clampToContainer = (value: number): number => {
      const parent = element.parentElement
      let low = -MAX_LAG_PX
      let high = MAX_LAG_PX
      if (parent !== null) {
        const box = element.getBoundingClientRect()
        const area = parent.getBoundingClientRect()
        low = Math.max(low, area.top - (box.top - offset))
        high = Math.min(high, area.bottom - (box.bottom - offset))
      }
      return Math.min(Math.max(value, Math.min(low, 0)), Math.max(high, 0))
    }

    const rest = () => {
      offset = 0
      velocity = 0
      element.style.transform = ''
      element.style.willChange = ''
      previousTop = stickyTop()
    }

    const step = (time: number) => {
      frame = 0
      const dt = Math.min((time - lastTime) / 1000, MAX_DT)
      lastTime = time
      const top = stickyTop()
      // The target moved by (top - previousTop); the rail has not, yet.
      offset = clampToContainer(offset - (top - previousTop))
      previousTop = top
      const next = springStep({ x: offset, v: velocity }, dt, FOLLOW_OMEGA)
      offset = next.x
      velocity = next.v
      if (isSettled(next)) {
        rest()
        return
      }
      element.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`
      frame = window.requestAnimationFrame(step)
    }

    const wake = () => {
      if (frame !== 0) return
      lastTime = performance.now()
      element.style.willChange = 'transform'
      frame = window.requestAnimationFrame(step)
    }

    // A resize changes the layout under us: forget the old geometry.
    const onResize = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      rest()
    }

    window.addEventListener('scroll', wake, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', wake)
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      element.style.transform = ''
      element.style.willChange = ''
    }
  }, [ref, active])
}
