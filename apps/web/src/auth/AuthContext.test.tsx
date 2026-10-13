import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'
import { CSRF_BROADCAST_KEY, requestReauth } from './sessionRecovery'

const STORAGE_KEY = 'teleyes.csrf_token'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function Probe() {
  const auth = useAuth()
  return (
    <>
      <p>
        {auth.status}|{auth.csrfToken ?? 'sem-token'}|{auth.csrfMissing ? 'csrf-faltando' : 'csrf-ok'}|
        {auth.sessionExpired ? 'expirada' : 'valida'}
      </p>
      <button type="button" onClick={() => void auth.login('senha')}>
        entrar
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        sair
      </button>
      <button type="button" onClick={auth.cancelReauth}>
        cancelar
      </button>
    </>
  )
}

function blockStorage() {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
}

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('AuthProvider without usable web storage (S12-04)', () => {
  it('renders, signs in and signs out with the token kept in memory only', async () => {
    blockStorage()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: 'no session' }, 401)) // /auth/me on mount
      .mockResolvedValueOnce(jsonResponse({ csrf_token: 'tok-123' })) // /auth/login
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me after login
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // /auth/logout

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('anonymous|sem-token|csrf-ok|valida')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))
    await waitFor(() => expect(screen.getByText('authenticated|tok-123|csrf-ok|valida')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'sair' }))
    await waitFor(() => expect(screen.getByText('anonymous|sem-token|csrf-ok|valida')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('AuthProvider with working web storage', () => {
  it('keeps the token across a reload, and clears it when signing out', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-abc')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me on mount
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // /auth/logout

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('authenticated|tok-abc|csrf-ok|valida')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'sair' }))
    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull())
  })
})

// S13-08: `AuthProvider` registers the handler `api/http.ts` calls through
// `sessionRecovery.requestReauth()` — these drive it the same way a failed
// write would, without going through the network layer.
describe('AuthProvider session recovery (S13-08)', () => {
  it('flips sessionExpired on a pending reauth, and login() resolves it with the fresh token', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me on mount
      .mockResolvedValueOnce(jsonResponse({ csrf_token: 'tok-fresh' })) // /auth/login (reauth)
      .mockResolvedValueOnce(jsonResponse({ admin_id: 1 })) // /auth/me after reauth

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('authenticated|tok-old|csrf-ok|valida')).toBeInTheDocument())

    const reauthResult = requestReauth()
    await waitFor(() => expect(screen.getByText(/expirada$/)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))

    await expect(reauthResult).resolves.toBe('tok-fresh')
    await waitFor(() => expect(screen.getByText('authenticated|tok-fresh|csrf-ok|valida')).toBeInTheDocument())
  })

  it('cancelReauth clears the flag and rejects the write waiting on it', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ admin_id: 1 }))

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('authenticated|tok-old|csrf-ok|valida')).toBeInTheDocument())

    const reauthResult = requestReauth()
    // Attached synchronously, before the rejection can happen (on the click
    // below) — otherwise Node flags the promise as unhandled during the
    // several microtask hops `userEvent.click` takes before this function
    // gets back here to await it.
    reauthResult.catch(() => {})
    await waitFor(() => expect(screen.getByText(/expirada$/)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'cancelar' }))

    await expect(reauthResult).rejects.toThrow('Reautenticação cancelada')
    expect(screen.getByText(/valida$/)).toBeInTheDocument()
  })

  it('adopts a fresh token broadcast from another tab and clears its own expired state', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ admin_id: 1 }))

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('authenticated|tok-old|csrf-ok|valida')).toBeInTheDocument())

    const reauthResult = requestReauth()
    await waitFor(() => expect(screen.getByText(/expirada$/)).toBeInTheDocument())

    // Simulate the browser's own cross-tab `storage` event — another tab
    // just reauthenticated and wrote the broadcast key.
    window.localStorage.setItem(CSRF_BROADCAST_KEY, JSON.stringify({ token: 'tok-other-tab', at: Date.now() }))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: CSRF_BROADCAST_KEY,
        newValue: window.localStorage.getItem(CSRF_BROADCAST_KEY),
      }),
    )

    await waitFor(() =>
      expect(screen.getByText('authenticated|tok-other-tab|csrf-ok|valida')).toBeInTheDocument(),
    )
    await expect(reauthResult).resolves.toBe('tok-other-tab')
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('tok-other-tab')
  })

  it('ignores unrelated storage events', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'tok-old')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ admin_id: 1 }))

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('authenticated|tok-old|csrf-ok|valida')).toBeInTheDocument())

    window.dispatchEvent(new StorageEvent('storage', { key: 'some.other.key', newValue: 'whatever' }))

    // Nothing changes.
    expect(screen.getByText('authenticated|tok-old|csrf-ok|valida')).toBeInTheDocument()
  })
})
