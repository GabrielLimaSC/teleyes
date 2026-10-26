import { useCallback, useLayoutEffect, useRef } from 'react'

/** A callback with a permanent identity that always runs the latest closure —
 * lets memoized lists skip re-renders caused only by unrelated page state
 * (S20-03: opening/closing the product panel must not re-render every row). */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const ref = useRef(callback)
  useLayoutEffect(() => {
    ref.current = callback
  })
  return useCallback((...args: Args) => ref.current(...args), [])
}
