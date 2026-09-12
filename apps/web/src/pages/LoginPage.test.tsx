import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthContext'
import { LoginPage } from './LoginPage'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(handlers: {
  me?: () => Response
  login?: () => Response
  logout?: () => Response
}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/auth/me')) return Promise.resolve(handlers.me?.() ?? jsonResponse(null, 401))
    if (url.endsWith('/auth/login') && method === 'POST') {
      return Promise.resolve(handlers.login?.() ?? jsonResponse({ csrf_token: 'test-csrf' }))
    }
    if (url.endsWith('/auth/logout') && method === 'POST') {
      return Promise.resolve(handlers.logout?.() ?? new Response(null, { status: 200 }))
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginPage', () => {
  it('shows the login form when there is no session', async () => {
    mockFetch({})

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    expect(await screen.findByLabelText('Senha')).toBeInTheDocument()
    expect(screen.queryByText(/Verificando sessão/)).not.toBeInTheDocument()
  })

  it('logs in with the real API contract and shows the authenticated view', async () => {
    let loggedIn = false
    mockFetch({
      me: () => jsonResponse(loggedIn ? { admin_id: 1 } : null, loggedIn ? 200 : 401),
      login: () => {
        loggedIn = true
        return jsonResponse({ csrf_token: 'test-csrf' })
      },
    })
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await user.type(await screen.findByLabelText('Senha'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText(/Sessão ativa \(admin #1\)/)).toBeInTheDocument()
    expect(sessionStorage.getItem('teleyes.csrf_token')).toBe('test-csrf')
  })

  it('shows an error message when the password is wrong', async () => {
    mockFetch({ login: () => jsonResponse({ detail: 'invalid credentials' }, 401) })
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await user.type(await screen.findByLabelText('Senha'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Senha incorreta.')
  })

  it('logs out and returns to the login form', async () => {
    let loggedIn = true
    mockFetch({
      me: () => jsonResponse(loggedIn ? { admin_id: 1 } : null, loggedIn ? 200 : 401),
      logout: () => {
        loggedIn = false
        return new Response(null, { status: 200 })
      },
    })
    sessionStorage.setItem('teleyes.csrf_token', 'test-csrf')
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Sair' }))

    await waitFor(() => expect(screen.getByLabelText('Senha')).toBeInTheDocument())
    expect(sessionStorage.getItem('teleyes.csrf_token')).toBeNull()
  })

  it('warns instead of crashing when a reload lost the CSRF token', async () => {
    mockFetch({ me: () => jsonResponse({ admin_id: 1 }) })
    // no sessionStorage csrf token seeded — simulates a page reload

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    expect(await screen.findByText(/perdeu o token de sessão/)).toBeInTheDocument()
  })
})
