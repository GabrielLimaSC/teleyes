import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegrasPage } from './RegrasPage'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    adminId: 1,
    csrfMissing: false,
    csrfToken: 'test-csrf',
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

const baseRule = {
  id: 1,
  name: 'iPhone',
  include_terms: 'iphone',
  exclude_terms: null,
  max_price_cents: 400_000,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('RegrasPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists rules with their terms, price limit and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([baseRule]))),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('iPhone')).toBeInTheDocument()
    expect(screen.getByText('R$ 4.000,00')).toBeInTheDocument()
    expect(screen.getByText('ativa')).toBeInTheDocument()
  })

  it('creates a rule and shows the API validation error on failure', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return Promise.resolve(jsonResponse([]))
      if (method === 'POST') {
        return Promise.resolve(jsonResponse({ detail: 'include_terms must not be blank' }, 422))
      }
      throw new Error(`unexpected ${method} ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: '+ Nova regra' }))
    await user.type(screen.getByLabelText(/Nome/), 'Regra sem termo')
    await user.type(screen.getByLabelText(/Termos incluídos/), ' ')
    await user.click(screen.getByRole('button', { name: 'Salvar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('include_terms must not be blank')
  })

  it('duplicating a rule pre-fills the create form with a copy suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([baseRule]))),
    )
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Duplicar' }))

    expect(screen.getByRole('heading', { name: 'Nova regra' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome/)).toHaveValue('iPhone (cópia)')
    expect(screen.getByLabelText(/Termos incluídos/)).toHaveValue('iphone')
  })

  it('the rule tester previews a match without calling the API', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([baseRule])))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Testar' }))
    await user.type(screen.getByLabelText('Mensagem de exemplo'), 'Promoção iPhone 15')

    expect(await screen.findByText('✅ Bateria com esta regra')).toBeInTheDocument()
    // only the initial GET /rules call — the tester never touches the network
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('pausing a rule calls the pause endpoint and reloads the list', async () => {
    const paused = { ...baseRule, active: false }
    let pauseCalled = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/pause')) {
        pauseCalled = true
        return Promise.resolve(jsonResponse(paused))
      }
      if (method === 'GET') return Promise.resolve(jsonResponse(pauseCalled ? [paused] : [baseRule]))
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'ativa' }))

    expect(await screen.findByRole('button', { name: 'pausada' })).toBeInTheDocument()
  })
})
