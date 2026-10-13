import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/auth'
import { fetchListenerStatus, requestListenerReload } from '../api/listener'
import type { ListenerStatus } from '../api/listener'
import { CSRF_MISSING_MESSAGE } from '../auth/AuthContext'

const IDLE_POLL_MS = 5000
// While a request is in flight the listener answers within seconds: look often.
const BUSY_POLL_MS = 1500

interface Options {
  csrfToken?: string | null
  /** Called once when a request that was pending/applying ends (`idle` or `failed`). */
  onSettled?: (status: ListenerStatus) => void
}

/**
 * S13-06: polls `GET /listener/status` and owns the "Aplicar regras" request.
 * `refresh()` re-reads at once (a page calls it right after a rule/source/
 * recipient changed, so the "há mudanças não aplicadas" notice does not wait
 * for the next tick). `error` is a readable pt-BR message for the last failed
 * read or request; a failed *apply* is not an error here, it arrives as
 * `status.state === 'failed'`.
 */
export function useListenerStatus({ csrfToken = null, onSettled }: Options = {}) {
  const [status, setStatus] = useState<ListenerStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [tick, setTick] = useState(0)
  const previousState = useRef<ListenerStatus['state'] | null>(null)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  })

  const accept = useCallback((next: ListenerStatus) => {
    const before = previousState.current
    previousState.current = next.state
    setStatus(next)
    setError(null)
    if ((before === 'pending' || before === 'applying') && (next.state === 'idle' || next.state === 'failed')) {
      onSettledRef.current?.(next)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    fetchListenerStatus()
      .then((next) => {
        if (!cancelled) accept(next)
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível consultar o estado do listener.')
      })
      .finally(() => {
        if (cancelled) return
        // Chosen after the answer, from what it said: no second fetch just
        // because the state changed.
        const inFlight = previousState.current === 'pending' || previousState.current === 'applying'
        timer = setTimeout(() => setTick((value) => value + 1), inFlight ? BUSY_POLL_MS : IDLE_POLL_MS)
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tick, accept])

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  const apply = useCallback(() => {
    if (csrfToken === null) {
      setError(CSRF_MISSING_MESSAGE)
      return
    }
    setRequesting(true)
    setError(null)
    requestListenerReload(csrfToken)
      .then((next) => {
        accept(next)
        setTick((value) => value + 1) // restart the cycle at the fast pace
      })
      .catch((failure: unknown) => {
        setError(failure instanceof ApiError ? failure.message : 'Não foi possível pedir a aplicação.')
      })
      .finally(() => setRequesting(false))
  }, [csrfToken, accept])

  return { status, error, requesting, refresh, apply }
}
