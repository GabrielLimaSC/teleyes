import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

const STORAGE_KEY = 'teleyes.csrf_token'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function Probe() {
  const auth = useAuth()
  return (
    <>
      <p>
        {auth.status}|{auth.csrfToken ?? 'sem-token'}|{auth.csrfMissing ? 'csrf-faltando' : 'csrf-ok'}
      </p>
      <button type="button" onClick={() => void auth.login('senha')}>
        entrar
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        sair
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
    await waitFor(() => expect(screen.getByText('anonymous|sem-token|csrf-ok')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))
    await waitFor(() => expect(screen.getByText('authenticated|tok-123|csrf-ok')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'sair' }))
    await waitFor(() => expect(screen.getByText('anonymous|sem-token|csrf-ok')).toBeInTheDocument())
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
    await waitFor(() => expect(screen.getByText('authenticated|tok-abc|csrf-ok')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'sair' }))
    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull())
  })
})
