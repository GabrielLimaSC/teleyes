import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveMatches } from './useLiveMatches'
import * as matchesApi from '../api/matches'
import type { Match } from '../api/types'

function buildMatch(id: number): Match {
  return {
    id,
    source_id: 1,
    rule_id: 1,
    message_text: `match ${id}`,
    price_cents: null,
    message_link: null,
    matched_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    deliveries: [],
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }

  dispatch(type: string, data = '{}') {
    for (const listener of this.listeners[type] ?? []) listener({ data } as MessageEvent)
  }

  close() {
    this.closed = true
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useLiveMatches', () => {
  it('loads the initial history once on mount', async () => {
    const spy = vi.spyOn(matchesApi, 'fetchMatches').mockResolvedValue([])

    const { result } = renderHook(() => useLiveMatches())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reloads the list when a match event arrives', async () => {
    const spy = vi.spyOn(matchesApi, 'fetchMatches')
    spy.mockResolvedValueOnce([]).mockResolvedValueOnce([buildMatch(1)])

    const { result } = renderHook(() => useLiveMatches())
    await waitFor(() => expect(result.current.loading).toBe(false))

    FakeEventSource.instances[0].dispatch('match', JSON.stringify({ match_id: 1 }))

    await waitFor(() => expect(result.current.matches).toHaveLength(1))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('reloads on resync as a full replace, not an append', async () => {
    const spy = vi.spyOn(matchesApi, 'fetchMatches')
    spy.mockResolvedValueOnce([buildMatch(1)]).mockResolvedValueOnce([buildMatch(2)])

    const { result } = renderHook(() => useLiveMatches())
    await waitFor(() => expect(result.current.matches).toHaveLength(1))

    FakeEventSource.instances[0].dispatch('resync')

    await waitFor(() => expect(result.current.matches.map((match) => match.id)).toEqual([2]))
  })

  it('closes the EventSource connection on unmount', async () => {
    vi.spyOn(matchesApi, 'fetchMatches').mockResolvedValue([])
    const { unmount } = renderHook(() => useLiveMatches())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    unmount()

    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('refresh() reloads the list on demand, same as an SSE event (S7-02)', async () => {
    const spy = vi.spyOn(matchesApi, 'fetchMatches')
    spy.mockResolvedValueOnce([]).mockResolvedValueOnce([buildMatch(1)])

    const { result } = renderHook(() => useLiveMatches())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(spy).toHaveBeenCalledTimes(1)

    result.current.refresh()

    await waitFor(() => expect(result.current.matches).toHaveLength(1))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('surfaces an error state when the initial load fails', async () => {
    vi.spyOn(matchesApi, 'fetchMatches').mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useLiveMatches())

    await waitFor(() => expect(result.current.error).not.toBeNull())
  })
})
