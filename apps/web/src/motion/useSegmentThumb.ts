import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { prefersReducedMotion, supportsWaapi } from './tokens'
import { CHROME_SPRING_EASING } from './tokens'
import './motion.css'

const ACTIVE = '[aria-selected="true"], [aria-checked="true"], [aria-pressed="true"]'
const SLIDE_MS = 420

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * S25-M1: the sliding indicator of a segmented control or tab list.
 *
 *   const { containerRef, thumbRef } = useSegmentThumb<HTMLDivElement>(value)
 *   <div ref={containerRef} className="motion-seg …" role="tablist">
 *     <span ref={thumbRef} className="motion-seg__thumb" aria-hidden="true" />
 *     <button aria-selected={…}>…</button>
 *   </div>
 *
 * The thumb sits behind the buttons and follows the one that is selected
 * (`aria-selected`, `aria-checked` or `aria-pressed`). When the selection
 * changes it springs from the old box to the new one with `transform` only
 * (translate, plus a scale when the two tabs differ in size). The first
 * measure, a resize, and reduced motion place it without animating. The
 * selected button must be transparent: the thumb is its background.
 */
export function useSegmentThumb<T extends HTMLElement>(
  value: unknown,
): { containerRef: RefObject<T | null>; thumbRef: RefObject<HTMLSpanElement | null> } {
  const containerRef = useRef<T>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const last = useRef<Box | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const thumb = thumbRef.current
    if (container === null || thumb === null) return

    const place = (animate: boolean) => {
      const active = container.querySelector<HTMLElement>(ACTIVE)
      if (active === null || active.offsetWidth === 0) {
        thumb.style.opacity = '0'
        last.current = null
        return
      }
      // Fractional boxes (flex-sized tabs are rarely whole pixels), relative to
      // the container's padding edge, which is what `position: absolute` uses.
      const area = container.getBoundingClientRect()
      const box = active.getBoundingClientRect()
      const next: Box = {
        x: box.left - area.left - container.clientLeft,
        y: box.top - area.top - container.clientTop,
        width: box.width,
        height: box.height,
      }
      const previous = last.current
      last.current = next
      thumb.style.width = `${next.width}px`
      thumb.style.height = `${next.height}px`
      thumb.style.transform = `translate(${next.x}px, ${next.y}px)`
      thumb.style.opacity = '1'
      if (!animate || previous === null || !supportsWaapi() || prefersReducedMotion()) return
      thumb.animate(
        [
          { transform: `translate(${previous.x}px, ${previous.y}px) scale(${previous.width / next.width}, ${previous.height / next.height})` },
          { transform: `translate(${next.x}px, ${next.y}px) scale(1, 1)` },
        ],
        { duration: SLIDE_MS, easing: CHROME_SPRING_EASING },
      )
    }

    place(true)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    observer.observe(container)
    return () => observer.disconnect()
  }, [value])

  return { containerRef, thumbRef }
}
