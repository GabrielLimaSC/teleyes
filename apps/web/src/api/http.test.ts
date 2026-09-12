import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './http'
import { ApiError } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
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
