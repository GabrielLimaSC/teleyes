import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/auth'
import { fetchSetupStatus } from '../api/setup'
import type { SetupStatus } from '../api/setup'

/** Why the wizard is not offered at all. `demo`: the API (or the static demo) refuses it. */
export type SetupUnavailable = 'demo' | 'missing' | null

interface UseSetupStatusResult {
  status: SetupStatus | null
  loading: boolean
  error: string | null
  unavailable: SetupUnavailable
  refresh: () => void
  /** Takes the status a mutating call already returned, with no extra request. */
  apply: (status: SetupStatus) => void
}

/**
 * S19-02: the wizard's one source of truth is the server (`GET /setup/status`), so a
 * closed tab, a reload or a second tab resume at the right step. `pollMs = 0` reads
 * it once (the banners); a positive value keeps it fresh (the wizard page).
 */
export function useSetupStatus(pollMs = 0): UseSetupStatusResult {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<SetupUnavailable>(null)
  const alive = useRef(true)

  const load = useCallback(() => {
    fetchSetupStatus()
      .then((next) => {
        if (!alive.current) return
        setStatus(next)
        setError(null)
        setUnavailable(null)
      })
      .catch((failure: unknown) => {
        if (!alive.current) return
        if (failure instanceof ApiError && failure.status === 403) {
          setUnavailable('demo')
        } else if (failure instanceof ApiError && failure.status === 404) {
          setUnavailable('missing')
        } else {
          setError('Não foi possível consultar o estado da configuração.')
        }
      })
      .finally(() => {
        if (alive.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    const interval = pollMs > 0 ? setInterval(load, pollMs) : null
    return () => {
      alive.current = false
      if (interval !== null) clearInterval(interval)
    }
  }, [load, pollMs])

  const apply = useCallback((next: SetupStatus) => {
    setStatus(next)
    setError(null)
    setUnavailable(null)
  }, [])

  return { status, loading, error, unavailable, refresh: load, apply }
}
