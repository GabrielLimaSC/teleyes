import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaudePage } from './SaudePage'

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>()
  return {
    ...actual,
    useAuth: () => ({
      status: 'authenticated',
      adminId: 1,
      csrfMissing: false,
      csrfToken: 'test-csrf',
      login: vi.fn(),
      logout: vi.fn(),
    }),
  }
})

class InertEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const recipient = {
  id: 1,
  name: 'Gabriel',
  telegram_chat_id: '999',
  allowlisted: true,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

const health = {
  status: 'ok',
  env: 'development',
  version: '0.1.0',
  uptime_seconds: 90,
  telegram: { configured: false, state: 'not_configured' },
  bot: { configured: false, state: 'not_configured' },
}

// S11-06: the summary panel also reads /sources and /matches.
// Empty by default; a test that cares passes its own.
function summaryEndpoints(url: string, overrides: Record<string, () => Response> = {}): Response | null {
  for (const [prefix, respond] of Object.entries(overrides)) {
    if (url.startsWith(prefix)) return respond()
  }
  if (url.startsWith('/sources') || url.startsWith('/matches')) {
    return jsonResponse([])
  }
  return null
}

beforeEach(() => {
  vi.stubGlobal('EventSource', InertEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SaudePage', () => {
  it('shows "Conectando…" for SSE before the EventSource opens, never a premature "Desconectado"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        const summary = summaryEndpoints(url)
        if (summary) return Promise.resolve(summary)
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<SaudePage />)

    expect(await screen.findByText('Conectando…')).toBeInTheDocument()
    expect(screen.queryByText('Desconectado')).not.toBeInTheDocument()
  })

  it('shows the not_configured state for Telegram, bot and the test result honestly', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/health') return Promise.resolve(jsonResponse(health))
      if (url === '/recipients') return Promise.resolve(jsonResponse([recipient]))
      if (url === '/notifications/test' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({ delivered: false, status: 'not_configured', recipient_id: 1, chat_id: '999' }),
        )
      }
      const summary = summaryEndpoints(url)
      if (summary) return Promise.resolve(summary)
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<SaudePage />)

    // both Telegram and Bot rows show "Não configurado" — one per real field.
    await waitFor(() => expect(screen.getAllByText('Não configurado')).toHaveLength(2))

    await user.selectOptions(await screen.findByLabelText('Destinatário'), '1')
    await user.click(screen.getByRole('button', { name: 'Enviar teste' }))

    expect(await screen.findByText('Não entregue — status: not_configured.')).toBeInTheDocument()
  })

  it('surfaces the real API error when the recipient is not eligible', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/health') return Promise.resolve(jsonResponse(health))
      if (url === '/recipients') return Promise.resolve(jsonResponse([recipient]))
      if (url === '/notifications/test' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({ detail: 'recipient must be active and allowlisted' }, 403),
        )
      }
      const summary = summaryEndpoints(url)
      if (summary) return Promise.resolve(summary)
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<SaudePage />)

    await user.selectOptions(await screen.findByLabelText('Destinatário'), '1')
    await user.click(screen.getByRole('button', { name: 'Enviar teste' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('recipient must be active and allowlisted'),
    )
  })

  it('shows the four status tiles with real details and the real env var names (S11-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(summaryEndpoints(url) ?? jsonResponse([]))
      }),
    )

    render(<SaudePage />)

    // health.uptime_seconds is 90 → "1min 30s"
    expect(await screen.findByText('v0.1.0 · tempo ativo 1min 30s')).toBeInTheDocument()
    expect(screen.getByText('development')).toBeInTheDocument()
    for (const label of ['Telegram', 'Bot', 'Feed em tempo real (SSE)', 'Ambiente']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // The names the backend actually reads (config.py), not the concept's "API_ID".
    expect(screen.getByText('TG_API_ID')).toBeInTheDocument()
    expect(screen.getByText('TG_API_HASH')).toBeInTheDocument()
    // in the Bot tile and again in the notification test's description
    expect(screen.getAllByText('BOT_TOKEN')).toHaveLength(2)
  })

  it('shows the real numbers in the collector summary (S11-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(
          summaryEndpoints(url, {
            '/sources': () =>
              jsonResponse([
                { id: 1, name: 'A', telegram_chat_id: '-1', active: true, created_at: '2026-01-01T00:00:00Z' },
                { id: 2, name: 'B', telegram_chat_id: '-2', active: true, created_at: '2026-01-01T00:00:00Z' },
              ]),
            '/matches': () => jsonResponse([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]),
          }) ?? jsonResponse([]),
        )
      }),
    )

    render(<SaudePage />)

    const panel = (await screen.findByRole('heading', { name: 'Resumo do coletor' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Fontes ativas').nextElementSibling).toHaveTextContent('2'))
    expect(within(panel).getByText('Matches gerados').nextElementSibling).toHaveTextContent('4')
    // cumulative, not "hoje", and none of the concept's uninstrumented numbers.
    expect(within(panel).getByText(/Contagens de agora/)).toBeInTheDocument()
    // No label claims a per-message count nor any number the app does not track.
    for (const invented of [
      'Mensagens lidas',
      'Mensagens vistas',
      'Última reconexão',
      'Fila de envio',
      'Erros na última hora',
      'Atividade do coletor',
    ]) {
      expect(screen.queryByText(invented)).not.toBeInTheDocument()
    }
  })

  it('shows "—" instead of a made-up number when the summary cannot load (S11-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(new Response('boom', { status: 500 }))
      }),
    )

    render(<SaudePage />)

    const panel = (await screen.findByRole('heading', { name: 'Resumo do coletor' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Fontes ativas').nextElementSibling).toHaveTextContent('—'))
    expect(within(panel).getByText('Matches gerados').nextElementSibling).toHaveTextContent('—')
  })

  it('hints why the send button is off, from the real state only (S11-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([recipient]))
        return Promise.resolve(summaryEndpoints(url) ?? jsonResponse([]))
      }),
    )
    const user = userEvent.setup()

    render(<SaudePage />)

    expect(await screen.findByText('Selecione um destinatário para habilitar o envio.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar teste' })).toBeDisabled()

    await user.selectOptions(await screen.findByLabelText('Destinatário'), '1')

    expect(screen.getByRole('button', { name: 'Enviar teste' })).toBeEnabled()
    expect(screen.getByText(/O bot está sem token/)).toBeInTheDocument()
  })
})
