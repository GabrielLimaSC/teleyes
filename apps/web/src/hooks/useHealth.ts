import { useEffect, useState } from 'react'
import { fetchHealth } from '../api/health'
import type { AdapterState, HealthResponse } from '../api/health'

const POLL_INTERVAL_MS = 5000

export type SseState = 'connecting' | 'open' | 'error'

interface UseHealthResult {
  health: HealthResponse | null
  loading: boolean
  error: string | null
  sseState: SseState
}

/**
 * "Tempo real" here is two things working together: a poll every few seconds
 * for the authoritative GET /health snapshot (uptime, version, bot), and a
 * live EventSource purely to (a) report whether the app's own SSE connection
 * is actually up right now and (b) apply an `adapter_state` event the moment
 * it's published (packages/events/broker.py), so a Telegram state change
 * doesn't have to wait for the next poll tick.
 */
export function useHealth(pollIntervalMs = POLL_INTERVAL_MS): UseHealthResult {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Starts "connecting", not "error" — the EventSource handshake takes a
  // moment, and reporting a red "disconnected" before it's even had a chance
  // to open would be a false alarm, not an honest state.
  const [sseState, setSseState] = useState<SseState>('connecting')

  useEffect(() => {
    let cancelled = false

    const poll = () => {
      fetchHealth()
        .then((data) => {
          if (cancelled) return
          setHealth(data)
          setError(null)
        })
        .catch(() => {
          if (!cancelled) setError('Não foi possível consultar a saúde do sistema.')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    poll()
    const interval = setInterval(poll, pollIntervalMs)

    const source = new EventSource('/events')
    source.onopen = () => {
      if (!cancelled) setSseState('open')
    }
    source.onerror = () => {
      if (!cancelled) setSseState('error')
    }
    source.addEventListener('adapter_state', (event: MessageEvent<string>) => {
      if (cancelled) return
      const payload = JSON.parse(event.data) as { state: AdapterState }
      setHealth((current) =>
        current === null
          ? current
          : { ...current, telegram: { ...current.telegram, state: payload.state } },
      )
    })

    return () => {
      cancelled = true
      clearInterval(interval)
      source.close()
    }
  }, [pollIntervalMs])

  return { health, loading, error, sseState }
}
