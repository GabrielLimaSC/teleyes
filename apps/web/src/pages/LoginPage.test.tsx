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

const health = {
  status: 'ok',
  env: 'development',
  version: '0.1.0',
  uptime_seconds: 42,
  telegram: { configured: false, state: 'not_configured' },
  bot: { configured: true, state: 'configured' },
}

const rule = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  name: 'Regra',
  include_terms: 'promo',
  exclude_terms: null,
  max_price_cents: null,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  lowest_price_cents: null,
  ...overrides,
})

const source = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  name: 'Fonte',
  telegram_chat_id: '111',
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

const match = (matchedAt: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  source_id: 1,
  rule_id: 1,
  message_text: 'Promo',
  price_cents: 1000,
  price_cash_cents: null,
  price_card_cents: null,
  message_link: null,
  matched_at: matchedAt,
  created_at: matchedAt,
  deliveries: [],
  is_lowest_price_ever: false,
  grouped_source_ids: null,
  ...overrides,
})

// /events (SSE) só é alcançável autenticado — este stub deixa a conexão
// aberta sem exigir um servidor real de verdade, mesma técnica do
// SaudePage.test.tsx.
class InertEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}

function mockFetch(handlers: {
  me?: () => Response
  login?: () => Response
  logout?: () => Response
  rules?: () => Response
  sources?: () => Response
  matches?: () => Response
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
    if (url === '/health') return Promise.resolve(jsonResponse(health))
    if (url.startsWith('/rules')) return Promise.resolve(handlers.rules?.() ?? jsonResponse([]))
    if (url.startsWith('/sources')) return Promise.resolve(handlers.sources?.() ?? jsonResponse([]))
    if (url.startsWith('/matches')) return Promise.resolve(handlers.matches?.() ?? jsonResponse([]))
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('EventSource', InertEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

  it('shows the teleyes mascot as a decorative brand image (S7-09)', async () => {
    mockFetch({})

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await screen.findByLabelText('Senha')
    // Decorative — the "teleyes" heading right next to it already names the
    // brand for screen readers, so an empty alt avoids redundant noise
    // rather than announcing "imagem" or repeating the name.
    const mascot = document.querySelector('.login-card__mascot')
    expect(mascot).toBeInTheDocument()
    expect(mascot).toHaveAttribute('alt', '')
  })

  it('shows only the public health facts (Bot, Ambiente) pre-login, never private stats', async () => {
    mockFetch({})

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await screen.findByLabelText('Senha')
    expect(await screen.findByText('Configurado')).toBeInTheDocument()
    expect(await screen.findByText('development · v0.1.0')).toBeInTheDocument()
    // /rules, /sources e /matches exigem sessão — não devem ser chamados
    // antes do login.
    expect(screen.queryByText('Regras ativas')).not.toBeInTheDocument()
  })

  it('logs in with the real API contract and shows real stats in the authenticated view', async () => {
    let loggedIn = false
    mockFetch({
      me: () => jsonResponse(loggedIn ? { admin_id: 1 } : null, loggedIn ? 200 : 401),
      login: () => {
        loggedIn = true
        return jsonResponse({ csrf_token: 'test-csrf' })
      },
      rules: () => jsonResponse([rule({ id: 1, active: true }), rule({ id: 2, active: false })]),
      sources: () => jsonResponse([source({ id: 1, active: true })]),
      matches: () =>
        jsonResponse([
          match(new Date().toISOString()),
          match(new Date().toISOString()),
          match('2020-01-01T00:00:00Z'),
        ]),
    })
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await user.type(await screen.findByLabelText('Senha'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByText('Sessão ativa')).toBeInTheDocument()
    expect(await screen.findByText('Admin #1.')).toBeInTheDocument()
    expect(sessionStorage.getItem('teleyes.csrf_token')).toBe('test-csrf')

    const rulesTile = (await screen.findByText('Regras ativas')).closest('.login-stats__tile')
    expect(rulesTile).toHaveTextContent('1')
    const sourcesTile = screen.getByText('Fontes ouvindo').closest('.login-stats__tile')
    expect(sourcesTile).toHaveTextContent('1')
    const matchesTile = screen.getByText('Matches hoje').closest('.login-stats__tile')
    expect(matchesTile).toHaveTextContent('2')
  })

  it('counts "Matches hoje" by the local day of each instant, near UTC midnight (S13-01)', async () => {
    // Local now: 19 Sep 23:30 in America/Sao_Paulo = 02:30 UTC on the 20th.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 19, 23, 30, 0))
    let loggedIn = false
    mockFetch({
      me: () => jsonResponse(loggedIn ? { admin_id: 1 } : null, loggedIn ? 200 : 401),
      login: () => {
        loggedIn = true
        return jsonResponse({ csrf_token: 'test-csrf' })
      },
      rules: () => jsonResponse([]),
      sources: () => jsonResponse([]),
      matches: () =>
        jsonResponse([
          match('2026-09-20T01:43:00'), // 22:43 local today, sent with no zone (legacy shape)
          match('2026-09-20T01:43:00Z'), // the same instant, with the Z the API now sends
          match('2026-09-19T03:00:00Z'), // 00:00 local today: the first instant of the day
          match('2026-09-19T02:59:59Z'), // 23:59:59 local YESTERDAY, still 19 Sep in UTC
          match('2026-09-20T03:00:00Z'), // local tomorrow (00:00 on the 20th)
        ]),
    })
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )

    await user.type(await screen.findByLabelText('Senha'), 'correct horse battery staple')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    const matchesTile = (await screen.findByText('Matches hoje')).closest('.login-stats__tile')
    expect(matchesTile).toHaveTextContent('3')
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
