import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/auth'

/** Re-renders once a second while `active`, so a countdown read from the clock stays fresh. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((count) => count + 1), 1000)
    return () => clearInterval(timer)
  }, [active])
}

/** Counts down from `seconds` (re-synced whenever the server sends a new value). */
export function useCountdown(seconds: number | null | undefined): number | null {
  // A new `seconds` (every status poll) starts a new deadline.
  const deadline = useMemo(
    () => (seconds === null || seconds === undefined ? null : Date.now() + seconds * 1000),
    [seconds],
  )
  useSecondTick(deadline !== null)
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

/**
 * Blocks a button while the server (rate limit) or Telegram (flood wait) asks us to
 * wait, and counts the seconds down, so the user is never invited to hammer a
 * locked action.
 */
export function useRetryLock(): {
  remaining: number
  locked: boolean
  lockFrom: (error: unknown) => void
} {
  const [until, setUntil] = useState<number | null>(null)
  useSecondTick(until !== null)

  const lockFrom = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
      setUntil(Date.now() + error.retryAfterSeconds * 1000)
    }
  }, [])

  const remaining = until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))
  return { remaining, locked: remaining > 0, lockFrom }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback
