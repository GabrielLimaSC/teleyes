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
  lowest_price_cents: null,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * S7-01: `RegrasPage` now renders `DestinatariosSection` inline (same
 * `.crud-page` container, no longer a sibling route element), so every test
 * here also has to answer its `GET /recipients` call — otherwise it either
 * throws on an unhandled URL or, worse, silently reuses the rules mock data
 * as if it were recipients (a rule named "iPhone" becomes a fake "ativa"
 * recipient row, breaking `getByRole('button', { name: 'ativa' })`
 * uniqueness). Always empty here: no test in this file exercises recipients.
 */
function withEmptyRecipients(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
    return handler(input, init)
  }
}

describe('RegrasPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists rules with their terms, price limit and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('iPhone')).toBeInTheDocument()
    expect(screen.getByText('R$ 4.000,00')).toBeInTheDocument()
    expect(screen.getByText('ativa')).toBeInTheDocument()
    // baseRule has no priced match yet — falls back to "—", not "R$ 0,00".
    // "Termos bloqueados" also renders "—" for a null exclude_terms, so this
    // targets the specific cell by its data-label instead of the bare text.
    const row = screen.getByText('iPhone').closest('tr') as HTMLElement
    expect(row.querySelector('[data-label="Menor preço já visto"]')).toHaveTextContent('—')
  })

  it('shows the real lowest price ever seen for a rule with a priced match (S7-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        withEmptyRecipients(() =>
          Promise.resolve(jsonResponse([{ ...baseRule, lowest_price_cents: 199_00 }])),
        ),
      ),
    )

    render(<RegrasPage />)

    expect(await screen.findByText('iPhone')).toBeInTheDocument()
    expect(screen.getByText('R$ 199,00')).toBeInTheDocument()
  })

  it('creates a rule and shows the API validation error on failure', async () => {
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET') return Promise.resolve(jsonResponse([]))
        if (method === 'POST') {
          return Promise.resolve(jsonResponse({ detail: 'include_terms must not be blank' }, 422))
        }
        throw new Error(`unexpected ${method} ${String(input)}`)
      }),
    )
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
      vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule])))),
    )
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'Duplicar' }))

    expect(screen.getByRole('heading', { name: 'Nova regra' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome/)).toHaveValue('iPhone (cópia)')
    expect(screen.getByLabelText(/Termos incluídos/)).toHaveValue('iphone')
  })

  it('the rule tester previews a match without calling the API', async () => {
    const fetchMock = vi.fn(withEmptyRecipients(() => Promise.resolve(jsonResponse([baseRule]))))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)
    await screen.findByText('iPhone')

    await user.click(await screen.findByRole('button', { name: 'Testar' }))
    await user.type(screen.getByLabelText('Mensagem de exemplo'), 'Promoção iPhone 15')

    expect(await screen.findByText('✅ Bateria com esta regra')).toBeInTheDocument()
    // Only the initial mount calls — GET /rules and DestinatariosSection's own
    // GET /recipients (S7-01: it now renders inline, inside the same page) —
    // the tester itself never touches the network.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('pausing a rule calls the pause endpoint and reloads the list', async () => {
    const paused = { ...baseRule, active: false }
    let pauseCalled = false
    const fetchMock = vi.fn(
      withEmptyRecipients((input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/pause')) {
          pauseCalled = true
          return Promise.resolve(jsonResponse(paused))
        }
        if (method === 'GET') return Promise.resolve(jsonResponse(pauseCalled ? [paused] : [baseRule]))
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<RegrasPage />)

    await user.click(await screen.findByRole('button', { name: 'ativa' }))

    expect(await screen.findByRole('button', { name: 'pausada' })).toBeInTheDocument()
  })
})
