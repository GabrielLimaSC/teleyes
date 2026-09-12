import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHealth } from './useHealth'
import * as healthApi from '../api/health'
import type { HealthResponse } from '../api/health'

function buildHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    env: 'development',
    version: '0.1.0',
    uptime_seconds: 12,
    telegram: { configured: false, state: 'not_configured' },
    bot: { configured: false, state: 'not_configured' },
    ...overrides,
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
  vi.useRealTimers()
})

describe('useHealth', () => {
  it('loads health once on mount', async () => {
    vi.spyOn(healthApi, 'fetchHealth').mockResolvedValue(buildHealth())

    const { result } = renderHook(() => useHealth(5000))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.health?.env).toBe('development')
  })

  it('polls again after the interval elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const spy = vi.spyOn(healthApi, 'fetchHealth').mockResolvedValue(buildHealth())

    renderHook(() => useHealth(1000))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(1000)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('applies a live adapter_state event immediately, without waiting for the next poll', async () => {
    vi.spyOn(healthApi, 'fetchHealth').mockResolvedValue(buildHealth())

    const { result } = renderHook(() => useHealth(60_000))
    await waitFor(() => expect(result.current.health).not.toBeNull())

    FakeEventSource.instances[0].dispatch('adapter_state', JSON.stringify({ state: 'connected' }))

    await waitFor(() => expect(result.current.health?.telegram.state).toBe('connected'))
  })

  it('starts "connecting" and reports open/error from the EventSource callbacks', async () => {
    vi.spyOn(healthApi, 'fetchHealth').mockResolvedValue(buildHealth())

    const { result } = renderHook(() => useHealth(60_000))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(result.current.sseState).toBe('connecting')

    FakeEventSource.instances[0].onopen?.()
    await waitFor(() => expect(result.current.sseState).toBe('open'))

    FakeEventSource.instances[0].onerror?.()
    await waitFor(() => expect(result.current.sseState).toBe('error'))
  })

  it('closes the EventSource and stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const spy = vi.spyOn(healthApi, 'fetchHealth').mockResolvedValue(buildHealth())

    const { unmount } = renderHook(() => useHealth(1000))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    unmount()
    expect(FakeEventSource.instances[0].closed).toBe(true)

    await vi.advanceTimersByTimeAsync(5000)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
