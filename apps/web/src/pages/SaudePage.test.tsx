import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenerStatus } from '../test/listenerFixtures'
import { SaudePage } from './SaudePage'

vi.mock('../auth/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/AuthContext')>()
  return {
    ...actual,
    useAuth: () => ({
      status: 'authenticated',
      adminId: 1,
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
  version: '1.0.0',
  uptime_seconds: 90,
  telegram: { configured: false, state: 'not_configured' },
  bot: { configured: false, state: 'not_configured' },
}

function historyFixture(overrides: Record<string, unknown> = {}) {
  return {
    hours: 24,
    coverage_since: '2020-01-01T00:00:00Z',
    services: [],
    collector: {
      coverage_since: '2020-01-01T00:00:00Z',
      hours: [],
      totals: { seen: 0, evaluated: 0, discarded: 0, delivery_failures: 0, delivery_failures_last_hour: 0 },
    },
    ...overrides,
  }
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
  if (url.startsWith('/listener/status')) return jsonResponse(listenerStatus())
  if (url.startsWith('/health/history')) return jsonResponse(historyFixture())
  if (url.startsWith('/health/events')) return jsonResponse([])
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

    expect(await screen.findByText('conectando')).toBeInTheDocument()
    expect(screen.queryByText('fora')).not.toBeInTheDocument()
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

    // Telegram and Bot both read "desligado" — one per real field, never a faked "ativo".
    await waitFor(() => expect(screen.getAllByText('desligado')).toHaveLength(2))

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

  it('shows the five service cards with real details and the real env var names (S11-06)', async () => {
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
    expect(await screen.findByText('1min 30s')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('development')).toBeInTheDocument()
    for (const label of ['Telegram', 'Bot', 'Leitor do Telegram', 'Atualização ao vivo', 'Banco']) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument()
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

    const panel = (await screen.findByRole('heading', { name: 'Coletor' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Grupos ativos').nextElementSibling).toHaveTextContent('2'))
    expect(within(panel).getByText('Ofertas encontradas').nextElementSibling).toHaveTextContent('4')
    // No label claims a per-message count nor any number the app does not track.
    for (const invented of [
      'Mensagens lidas',
      'Mensagens vistas',
      'Fila de envio',
      'Atividade do coletor',
    ]) {
      expect(screen.queryByText(invented)).not.toBeInTheDocument()
    }
  })

  it('counts real matches, not cards — a duplicate-grouped card counts every id it stands for (S14-07)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(
          summaryEndpoints(url, {
            '/sources': () => jsonResponse([]),
            // Two feed cards: one folds 3 real matches (duplicate grouping),
            // the other stands for itself alone — 4 real matches total, even
            // though `fetchMatches()` only returns 2 items.
            '/matches': () =>
              jsonResponse([
                { id: 1, grouped_match_ids: [1, 2, 3] },
                { id: 4, grouped_match_ids: [4] },
              ]),
          }) ?? jsonResponse([]),
        )
      }),
    )

    render(<SaudePage />)

    const panel = (await screen.findByRole('heading', { name: 'Coletor' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Ofertas encontradas').nextElementSibling).toHaveTextContent('4'))
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

    const panel = (await screen.findByRole('heading', { name: 'Coletor' })).closest('section') as HTMLElement
    await waitFor(() => expect(within(panel).getByText('Grupos ativos').nextElementSibling).toHaveTextContent('—'))
    expect(within(panel).getByText('Ofertas encontradas').nextElementSibling).toHaveTextContent('—')
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

  it('shows the verdict, bars and availability from the history, and the event list (S21-10)', async () => {
    class OpenEventSource extends InertEventSource {
      constructor() {
        super()
        setTimeout(() => this.onopen?.(), 0)
      }
    }
    vi.stubGlobal('EventSource', OpenEventSource)
    const bucket = (h: number, ok: number | null, total: number | null) => ({
      hour: `2026-11-03T${String(h).padStart(2, '0')}:00:00Z`,
      ok,
      total,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse({ ...health, demo: true }))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/health/history')) {
          return Promise.resolve(
            jsonResponse(
              historyFixture({
                services: [
                  {
                    service: 'db',
                    buckets: [bucket(1, 60, 60), bucket(2, 30, 60), bucket(3, 0, 60), bucket(4, null, null)],
                  },
                  { service: 'telegram', buckets: [bucket(1, null, null)] },
                ],
              }),
            ),
          )
        }
        if (url.startsWith('/health/events')) {
          return Promise.resolve(
            jsonResponse([
              { id: 2, at: '2026-11-03T12:00:00Z', kind: 'delivery_failure', summary: 'Envio falhou para Alex' },
              { id: 1, at: '2026-11-03T11:00:00Z', kind: 'rules_applied', summary: 'Regras aplicadas' },
            ]),
          )
        }
        return Promise.resolve(summaryEndpoints(url) ?? jsonResponse([]))
      }),
    )

    render(<SaudePage />)

    expect(await screen.findByRole('heading', { name: 'Operando em demonstração' })).toBeInTheDocument()
    // 90 of 180 samples across the three hours that have data; the null hour does not count.
    await waitFor(() => expect(screen.getByTestId('availability-db')).toHaveTextContent('50%'))
    // Telegram only has an unmeasured hour: no availability to claim.
    expect(screen.getByTestId('availability-telegram')).toHaveTextContent('—')
    const bars = screen.getByRole('img', { name: /^Banco/ }).querySelectorAll('.saude-bar')
    expect(bars).toHaveLength(24)
    expect(bars[20]).toHaveClass('saude-bar--ok')
    expect(bars[21]).toHaveClass('saude-bar--partial')
    expect(bars[22]).toHaveClass('saude-bar--down')
    expect(bars[23]).toHaveClass('saude-bar--none')
    expect(bars[21]).toHaveAttribute('title', expect.stringContaining('30/60'))
    expect(bars[0]).toHaveAttribute('title', 'coletando')
    expect(await screen.findByText('Envio falhou para Alex')).toBeInTheDocument()
    expect(screen.getByText('falha')).toBeInTheDocument()
    expect(screen.getByText('regras')).toBeInTheDocument()
  })

  it('shows a danger verdict when the SSE connection is down (S21-10)', async () => {
    class FailingEventSource extends InertEventSource {
      constructor() {
        super()
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    vi.stubGlobal('EventSource', FailingEventSource)
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

    expect(await screen.findByRole('heading', { name: 'Atenção: Atualização ao vivo fora' })).toBeInTheDocument()
  })

  it('reflects the typed message in the Telegram preview (S21-10)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        return Promise.resolve(summaryEndpoints(url) ?? jsonResponse([]))
      }),
    )
    const user = userEvent.setup()
    render(<SaudePage />)

    const input = await screen.findByLabelText('Mensagem')
    await user.clear(input)
    await user.type(input, 'Olá bolha')
    const preview = screen.getByLabelText('Prévia no Telegram')
    expect(within(preview).getByText('Olá bolha')).toBeInTheDocument()
    expect(within(preview).getByText('teleyes')).toBeInTheDocument()
  })

  it('omits the last-reconnect KPI when no such event exists (S21-10)', async () => {
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
    await screen.findByText('Descartadas · 24h')
    expect(screen.queryByText('Última reconexão')).not.toBeInTheDocument()
    expect(screen.getByText('Erros · 1h')).toBeInTheDocument()
  })

  it('shows what the listener is running with, in its own tile (S13-06)', async () => {
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

    const tile = (await screen.findByRole('heading', { name: 'Leitor do Telegram' })).closest('.saude-service') as HTMLElement
    await waitFor(() => expect(within(tile).getByText('ativo')).toBeInTheDocument())
    expect(tile).toHaveTextContent('2 grupos · 6 regras · 1 destinatário')
    expect(within(tile).getByText('ativo')).toBeInTheDocument()
  })

  it('tells where to apply when there are unapplied changes (S13-06)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/health') return Promise.resolve(jsonResponse(health))
        if (url === '/recipients') return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/listener/status')) {
          return Promise.resolve(jsonResponse(listenerStatus({ has_unapplied_changes: true })))
        }
        return Promise.resolve(summaryEndpoints(url) ?? jsonResponse([]))
      }),
    )

    render(<SaudePage />)

    const tile = (await screen.findByRole('heading', { name: 'Leitor do Telegram' })).closest('.saude-service') as HTMLElement
    await waitFor(() => expect(tile).toHaveTextContent('Aplique na página Regras.'))
  })
})
