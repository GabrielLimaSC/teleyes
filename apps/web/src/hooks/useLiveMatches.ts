import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchMatches } from '../api/matches'
import type { Match } from '../api/types'

export type FeedConnectionState = 'connecting' | 'open' | 'error'

interface LiveMatchesResult {
  matches: Match[]
  loading: boolean
  error: string | null
  connectionState: FeedConnectionState
  /** S7-02: reloads on demand (a visible "Atualizar" button), without
   * waiting for the next SSE `match`/`resync` event or a full page reload. */
  refresh: () => void
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
  // A ref, not a plain effect-local closure variable: `refresh` below needs
  // the exact same "am I still mounted" guard the SSE listeners use, and a
  // ref is what lets both share it without the callback identity changing.
  const cancelledRef = useRef(false)

  const reload = useCallback(() => {
    fetchMatches()
      .then((data) => {
        if (cancelledRef.current) return
        setMatches(data)
        setError(null)
      })
      .catch(() => {
        if (!cancelledRef.current) setError('Não foi possível carregar o feed.')
      })
      .finally(() => {
        if (!cancelledRef.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    reload()

    const source = new EventSource('/events')
    source.addEventListener('match', reload)
    source.addEventListener('resync', reload)
    source.onopen = () => {
      if (!cancelledRef.current) setConnectionState('open')
    }
    source.onerror = () => {
      if (!cancelledRef.current) setConnectionState('error')
    }

    return () => {
      cancelledRef.current = true
      source.close()
    }
  }, [reload])

  return { matches, loading, error, connectionState, refresh: reload }
}
