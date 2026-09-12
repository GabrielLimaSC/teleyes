import type { PointerEvent as ReactPointerEvent } from 'react'

/** Sets --fill-x/--fill-y (FillButton.css) from a pointer event's position
 * within the target element, so the color-fill animation expands from wherever
 * the user actually clicked/tapped rather than always the button's center. */
export function useFillOrigin() {
  return (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 100
    const y = ((event.clientY - rect.top) / rect.height) * 100
    event.currentTarget.style.setProperty('--fill-x', `${x}%`)
    event.currentTarget.style.setProperty('--fill-y', `${y}%`)
  }
}
