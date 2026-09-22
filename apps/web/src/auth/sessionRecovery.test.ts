import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/auth'
import { CSRF_BROADCAST_KEY, broadcastCsrfToken, registerReauthHandler, requestReauth } from './sessionRecovery'

afterEach(() => {
  registerReauthHandler(null)
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('requestReauth', () => {
  it('rejects with a friendly message when no handler is registered (no UI mounted)', async () => {
    await expect(requestReauth()).rejects.toMatchObject({
      message: 'Sessão expirada. Recarregue a página e faça login de novo.',
    } satisfies Partial<ApiError>)
  })

  it('delegates to the registered handler and resolves with its token', async () => {
    registerReauthHandler(() => Promise.resolve('tok-1'))

    await expect(requestReauth()).resolves.toBe('tok-1')
  })

  it('shares one in-flight attempt between concurrent callers instead of prompting twice', async () => {
    const handler = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve('tok-2'), 10)))
    registerReauthHandler(handler)

    const [first, second] = await Promise.all([requestReauth(), requestReauth()])

    expect(first).toBe('tok-2')
    expect(second).toBe('tok-2')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh attempt after a prior one settled', async () => {
    const handler = vi.fn().mockResolvedValueOnce('tok-a').mockResolvedValueOnce('tok-b')
    registerReauthHandler(handler)

    await expect(requestReauth()).resolves.toBe('tok-a')
    await expect(requestReauth()).resolves.toBe('tok-b')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('propagates a rejection from the handler (e.g. the admin cancelled) without caching it', async () => {
    registerReauthHandler(() => Promise.reject(new Error('cancelado')))

    await expect(requestReauth()).rejects.toThrow('cancelado')
  })
})

describe('broadcastCsrfToken', () => {
  it('writes a changing value under the broadcast key so other tabs get a storage event', () => {
    broadcastCsrfToken('tok-xyz')

    const stored = JSON.parse(window.localStorage.getItem(CSRF_BROADCAST_KEY) ?? 'null') as {
      token: string
      at: number
    }
    expect(stored.token).toBe('tok-xyz')
    expect(typeof stored.at).toBe('number')
  })

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    expect(() => broadcastCsrfToken('tok-xyz')).not.toThrow()
  })
})
