import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { useListenerStatus } from './useListenerStatus'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useListenerStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads the status and keeps polling it', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(listenerStatus())))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useListenerStatus())

    await waitFor(() => expect(result.current.status?.state).toBe('idle'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('polls faster while a request is in flight', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(listenerStatus({ state: 'pending' }))))
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useListenerStatus())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('apply() posts with the CSRF token and shows the pending answer at once', async () => {
    let requested = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/listener/reload' && init?.method === 'POST') {
        requested = true
        return Promise.resolve(json(listenerStatus({ state: 'pending' }), 202))
      }
      return Promise.resolve(json(listenerStatus({ state: requested ? 'pending' : 'idle' })))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useListenerStatus({ csrfToken: 'csrf-123' }))
    await waitFor(() => expect(result.current.status?.state).toBe('idle'))

    act(() => result.current.apply())

    await waitFor(() => expect(result.current.status?.state).toBe('pending'))
    const post = fetchMock.mock.calls.find(([url]) => String(url) === '/listener/reload')
    const init = post?.[1]
    expect(init?.method).toBe('POST')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['X-CSRF-Token']).toBe('csrf-123')
  })

  it('apply() without a CSRF token does not call the API and says why', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(json(listenerStatus())))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useListenerStatus({ csrfToken: null }))
    await waitFor(() => expect(result.current.status).not.toBeNull())

    act(() => result.current.apply())

    expect(result.current.error).toMatch(/sessão/i)
    expect(fetchMock.mock.calls.every(([url]) => String(url) !== '/listener/reload')).toBe(true)
  })

  it('calls onSettled once when a request ends, and not for a status that was already idle', async () => {
    const answers = [
      listenerStatus(),
      listenerStatus({ state: 'applying' }),
      listenerStatus({ new_matches: 4 }),
      listenerStatus({ new_matches: 4 }),
    ]
    const fetchMock = vi.fn(() => Promise.resolve(json(answers.shift() ?? listenerStatus())))
    vi.stubGlobal('fetch', fetchMock)
    const onSettled = vi.fn()
    const { result } = renderHook(() => useListenerStatus({ onSettled }))
    await waitFor(() => expect(result.current.status?.state).toBe('idle'))
    expect(onSettled).not.toHaveBeenCalled()

    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.status?.state).toBe('applying'))
    await act(() => vi.advanceTimersByTimeAsync(1500))
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ state: 'idle', new_matches: 4 })
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('refresh() re-reads immediately', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(listenerStatus())))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useListenerStatus())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => result.current.refresh())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('a failed read leaves a readable error and no made-up status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))))

    const { result } = renderHook(() => useListenerStatus())

    await waitFor(() => expect(result.current.error).toBe('Não foi possível consultar o estado do listener.'))
    expect(result.current.status).toBeNull()
  })
})
