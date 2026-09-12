import { useEffect, useState } from 'react'
import { fetchMatches } from '../api/matches'
import type { Match } from '../api/types'

export type FeedConnectionState = 'connecting' | 'open' | 'error'

interface LiveMatchesResult {
  matches: Match[]
  loading: boolean
  error: string | null
  connectionState: FeedConnectionState
}

/**
 * The `match`/`resync` SSE events (packages/events/broker.py) carry only a
 * summary payload, not the full match shape the feed renders (no
 * `message_text`, no `deliveries`) — and there's no `GET /matches/{id}`.
 * Reloading the whole list from `GET /matches` on every event is therefore
 * the only correct source of truth, and it happens to also make duplicate
 * events (a replay after reconnect, or a resync) a non-issue for free: the
 * list is always a full replace, never an incremental append.
 */
export function useLiveMatches(): LiveMatchesResult {
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<FeedConnectionState>('connecting')

  useEffect(() => {
    let cancelled = false

    const reload = () => {
      fetchMatches()
        .then((data) => {
          if (cancelled) return
          setMatches(data)
          setError(null)
        })
        .catch(() => {
          if (!cancelled) setError('Não foi possível carregar o feed.')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    reload()

    const source = new EventSource('/events')
    source.addEventListener('match', reload)
    source.addEventListener('resync', reload)
    source.onopen = () => {
      if (!cancelled) setConnectionState('open')
    }
    source.onerror = () => {
      if (!cancelled) setConnectionState('error')
    }

    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  return { matches, loading, error, connectionState }
}
