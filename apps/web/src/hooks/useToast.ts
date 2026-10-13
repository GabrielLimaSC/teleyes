import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastTone = 'success' | 'error'

export interface ToastState {
  id: number
  message: string
  tone: ToastTone
}

const DEFAULT_DURATION_MS = 4000

/**
 * S9-02: local (per-page), not a global provider — this codebase has no
 * app-wide state layer today (`AuthContext` is the only context, and it's
 * about identity, not UI feedback), and a single page's own success/error
 * feedback never needs to survive a navigation. Each caller owns its own
 * queue, same "no premature abstraction" spirit as everything else here.
 */
export function useToast(durationMs = DEFAULT_DURATION_MS) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nextId = useRef(0)

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    },
    [],
  )

  const dismiss = useCallback(() => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    setToast(null)
  }, [])

  const showToast = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      nextId.current += 1
      setToast({ id: nextId.current, message, tone })
      timeoutRef.current = setTimeout(() => setToast(null), durationMs)
    },
    [durationMs],
  )

  return { toast, showToast, dismiss }
}
