import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { supportsWaapi } from './tokens'
import { cancelExit } from './waapi'

/**
 * S25-M1: keeps a conditionally shown element mounted until its exit
 * animation ends.
 *
 *   const rendered = usePresence(open, panelRef, (el) => animateExit(el, DIALOG_PRESET))
 *   return rendered ? <div ref={panelRef} inert={!open}>…</div> : null
 *
 * `open` flips to false → `rendered` stays true while `runExit` plays on the
 * element behind `ref`, then turns false and the caller unmounts. Reopening in
 * the middle of an exit cancels it. Where WAAPI does not exist (jsdom) there is
 * no exit phase at all, so `rendered === open` and nothing waits.
 *
 * The element should be `inert` while `rendered && !open`: it is leaving, so
 * it must not take focus or clicks.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  runExit: (element: HTMLElement) => Promise<void>,
): boolean {
  const [state, setState] = useState({ previous: open, exiting: false })
  // Derived during render (no extra commit): the render that flips `open` to
  // false must already keep the element.
  if (state.previous !== open) setState({ previous: open, exiting: !open && supportsWaapi() })

  const exiting = state.exiting
  const runExitRef = useRef(runExit)
  useEffect(() => {
    runExitRef.current = runExit
  })
  // Reopened mid-exit: drop the exit before the browser paints its last frame.
  useLayoutEffect(() => {
    if (open) cancelExit(ref.current)
  }, [open, ref])
  useEffect(() => {
    if (open || !exiting) return
    const element = ref.current
    if (element === null) {
      setState((current) => ({ ...current, exiting: false }))
      return
    }
    let cancelled = false
    void runExitRef.current(element).then(() => {
      if (!cancelled) setState((current) => ({ ...current, exiting: false }))
    })
    return () => {
      cancelled = true
    }
  }, [open, exiting, ref])

  return open || exiting
}
