import { Component, createRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CHROME_SPRING_EASING, ENTER_MS, EXIT_EASING, SWAP_DISTANCE, prefersReducedMotion, supportsWaapi } from './tokens'
import './motion.css'

/** +1: the new content comes from the right (the next tab); -1: from the left. */
export type SwapDirection = 1 | -1

/** Direction of a move between two positions in an ordered list of tabs. */
export function swapDirection(from: number, to: number): SwapDirection {
  return to >= from ? 1 : -1
}

/**
 * Direction of the last change of `index`, for `<SwapTransition direction>`:
 * +1 while the index grows (next tab), -1 when it shrinks.
 */
export function useSwapDirection(index: number): SwapDirection {
  const [state, setState] = useState<{ index: number; direction: SwapDirection }>({ index, direction: 1 })
  if (state.index !== index) setState({ index, direction: swapDirection(state.index, index) })
  return state.direction
}

const EXIT_MS = 140

interface SwapTransitionProps {
  /** Changing this swaps the content (the active tab / segment). */
  swapKey: string | number
  direction?: SwapDirection
  className?: string
  /** Class on the box that holds the children (to keep a flex/grid layout). */
  contentClassName?: string
  children: ReactNode
}

/**
 * S25-M1: swaps the content of tabs and segments with a short, directional
 * motion. When `swapKey` changes the previous content leaves (it slides
 * `SWAP_DISTANCE` px the other way and fades out, as an inert copy laid over
 * the box) while the new content enters from the tab's side on the Feed's
 * spring (slide + fade). Both run at once, so a swap never costs waiting time.
 *
 * The new content is the real DOM, mounted immediately: state, focus and
 * clicks work from the first frame. Only `transform` and `opacity` move.
 * Under `prefers-reduced-motion` (or without WAAPI) it is a plain swap.
 *
 * It is a class component on purpose: `getSnapshotBeforeUpdate` is the one
 * hook that runs while the old DOM is still on the page, which is exactly
 * when the leaving copy has to be taken.
 *
 * The box carries `data-swap-direction` (forward | back) after a swap, and
 * `data-swapping` while it runs.
 */
export class SwapTransition extends Component<SwapTransitionProps> {
  private readonly outer = createRef<HTMLDivElement>()
  private readonly inner = createRef<HTMLDivElement>()

  getSnapshotBeforeUpdate(previous: SwapTransitionProps): HTMLElement | null {
    const inner = this.inner.current
    if (previous.swapKey === this.props.swapKey || inner === null || !supportsWaapi() || prefersReducedMotion()) return null
    const ghost = inner.cloneNode(true) as HTMLElement
    ghost.removeAttribute('id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.setAttribute('inert', '')
    ghost.classList.add('motion-swap__ghost')
    for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id')
    return ghost
  }

  componentDidUpdate(previous: SwapTransitionProps, _state: unknown, ghost: HTMLElement | null): void {
    if (previous.swapKey === this.props.swapKey) return
    const direction = this.props.direction ?? 1
    const outer = this.outer.current
    const inner = this.inner.current
    if (outer === null) return
    outer.dataset.swapDirection = direction === 1 ? 'forward' : 'back'
    if (ghost === null || inner === null) return

    outer.dataset.swapping = ''
    outer.appendChild(ghost)
    const slide = SWAP_DISTANCE * direction
    const leaving = ghost.animate(
      [
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: `translateX(${-slide}px)` },
      ],
      { duration: EXIT_MS, easing: EXIT_EASING, fill: 'forwards' },
    )
    const entering = inner.animate(
      [
        { opacity: 0, transform: `translateX(${slide}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: ENTER_MS, easing: CHROME_SPRING_EASING },
    )
    leaving.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    )
    const done = () => {
      // A newer swap may have started: only the last one clears the flag.
      if (outer.querySelectorAll('.motion-swap__ghost').length === 0) delete outer.dataset.swapping
    }
    void entering.finished.then(done, done)
  }

  render(): ReactNode {
    return (
      <div ref={this.outer} className={`motion-swap${this.props.className ? ` ${this.props.className}` : ''}`}>
        <div
          ref={this.inner}
          className={`motion-swap__content${this.props.contentClassName ? ` ${this.props.contentClassName}` : ''}`}
        >
          {this.props.children}
        </div>
      </div>
    )
  }
}
