import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './auth'
import {
  DEMO_READONLY_MESSAGE,
  isDemoReadOnly,
  notifyDemoReadOnly,
  onDemoReadOnly,
  reportFailure,
} from './demo'
import { apiRequest } from './http'

vi.mock('../auth/sessionRecovery', () => ({
  requestReauth: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('demo read-only handling', () => {
  it('recognises only the demo 403', () => {
    expect(isDemoReadOnly(403, DEMO_READONLY_MESSAGE)).toBe(true)
    expect(isDemoReadOnly(403, 'invalid csrf token')).toBe(false)
    expect(isDemoReadOnly(401, DEMO_READONLY_MESSAGE)).toBe(false)
  })

  it('delivers the notification to subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = onDemoReadOnly(listener)

    notifyDemoReadOnly()
    unsubscribe()
    notifyDemoReadOnly()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('skips the inline error for the demo refusal, but keeps it for real failures', () => {
    const report = vi.fn()

    reportFailure(new ApiError(DEMO_READONLY_MESSAGE, 403), 'Não foi possível pausar.', report)
    expect(report).not.toHaveBeenCalled()

    reportFailure(new ApiError('boom', 500), 'Não foi possível pausar.', report)
    reportFailure(new Error('rede'), 'Falhou.', report)
    expect(report).toHaveBeenNthCalledWith(1, 'Não foi possível pausar.')
    expect(report).toHaveBeenNthCalledWith(2, 'Falhou.')
  })

  it('apiRequest rejects a refused write with the demo message and notifies, without a reauth prompt', async () => {
    const { requestReauth } = await import('../auth/sessionRecovery')
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ detail: DEMO_READONLY_MESSAGE }), { status: 403 })),
      ),
    )
    const listener = vi.fn()
    const unsubscribe = onDemoReadOnly(listener)

    await expect(apiRequest('/rules/1', { method: 'DELETE' })).rejects.toMatchObject({
      message: DEMO_READONLY_MESSAGE,
      status: 403,
    })

    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(requestReauth).not.toHaveBeenCalled()
  })

  it('does not notify for other failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: 'nope' }), { status: 409 }))),
    )
    const listener = vi.fn()
    const unsubscribe = onDemoReadOnly(listener)

    await expect(apiRequest('/rules', { method: 'POST' })).rejects.toBeInstanceOf(ApiError)

    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
  })
})
