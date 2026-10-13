import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, jsonHeaders } from './http'
import { ApiError } from './auth'
import { requestReauth } from '../auth/sessionRecovery'

vi.mock('../auth/sessionRecovery', () => ({
  requestReauth: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(requestReauth).mockReset()
})

describe('apiRequest', () => {
  it('returns the parsed JSON body on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 1 })))),
    )

    await expect(apiRequest('/rules')).resolves.toEqual({ id: 1 })
  })

  it('returns undefined for a 204 with no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    )

    await expect(apiRequest('/rules/1')).resolves.toBeUndefined()
  })

  it('surfaces the real API detail message from a 404/409/422 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'telegram_chat_id already exists' }), { status: 409 }),
        ),
      ),
    )

    await expect(apiRequest('/sources')).rejects.toMatchObject({
      message: 'telegram_chat_id already exists',
      status: 409,
    } satisfies Partial<ApiError>)
  })

  it('falls back to a generic message when the error body has no detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not json', { status: 500 }))),
    )

    await expect(apiRequest('/rules')).rejects.toMatchObject({ status: 500 })
  })
})

// S13-08: the central write-interceptor — every mutating helper (rules.ts,
// recipients.ts, sources.ts, notifications.ts, listener.ts) goes through
// `apiRequest`, so this is the one place the "expired session/CSRF during a
// write" recovery needs covering, not each of those call sites.
describe('apiRequest write-session recovery (S13-08)', () => {
  it('on a write 401, asks sessionRecovery for a fresh token and retries with it — the caller never sees the raw error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'not authenticated' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, name: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(requestReauth).mockResolvedValueOnce('fresh-token')

    const result = await apiRequest('/rules', {
      method: 'POST',
      headers: jsonHeaders('stale-token'),
      body: '{}',
    })

    expect(result).toEqual({ id: 1, name: 'ok' })
    expect(requestReauth).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1].headers)
    expect(retryHeaders.get('X-CSRF-Token')).toBe('fresh-token')
  })

  it('on a write 403 "invalid csrf token", also recovers via sessionRecovery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'invalid csrf token' }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(requestReauth).mockResolvedValueOnce('fresh-token')

    await expect(
      apiRequest('/rules/1', { method: 'DELETE', headers: jsonHeaders('stale-token') }),
    ).resolves.toBeUndefined()
    expect(requestReauth).toHaveBeenCalledTimes(1)
  })

  it('a 403 for any other reason never triggers reauth and surfaces its own detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ detail: 'not allowed' }), { status: 403 })),
      ),
    )

    await expect(
      apiRequest('/rules', { method: 'POST', headers: jsonHeaders('tok') }),
    ).rejects.toMatchObject({ message: 'not allowed', status: 403 })
    expect(requestReauth).not.toHaveBeenCalled()
  })

  it('a GET that comes back 401 is never intercepted — only writes are', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ detail: 'not authenticated' }), { status: 401 })),
      ),
    )

    await expect(apiRequest('/rules')).rejects.toMatchObject({ status: 401 })
    expect(requestReauth).not.toHaveBeenCalled()
  })

  it('propagates a clear rejection (not the raw error) when reauth itself fails, without retrying forever', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: 'not authenticated' }), { status: 401 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(requestReauth).mockRejectedValueOnce(
      new ApiError('Reautenticação cancelada — tente a ação de novo quando quiser.', 401),
    )

    await expect(
      apiRequest('/rules', { method: 'POST', headers: jsonHeaders('tok') }),
    ).rejects.toMatchObject({ message: 'Reautenticação cancelada — tente a ação de novo quando quiser.' })
    // Only the original attempt — no retry was ever sent since reauth never
    // produced a token to retry with.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries at most once — a write that still fails after a successful reauth does not loop', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: 'not authenticated' }), { status: 401 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(requestReauth).mockResolvedValueOnce('fresh-token')

    await expect(
      apiRequest('/rules', { method: 'POST', headers: jsonHeaders('tok') }),
    ).rejects.toMatchObject({ status: 401 })
    expect(requestReauth).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
