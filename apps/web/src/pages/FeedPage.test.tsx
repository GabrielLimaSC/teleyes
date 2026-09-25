import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedPage } from './FeedPage'

// S14-07: FeedPage now reads `csrfToken` from `useAuth()` (the card's
// "Silenciar 7 dias"/"Definir alvo" actions and the sidebar's digest/
// grouping toggles) — same stub every other authenticated-page suite
// already uses (SaudePage.test.tsx), preserving every other real export
// (`CSRF_MISSING_MESSAGE`) instead of replacing the whole module.
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
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

// S14-08: FeedPage now reads/writes `?produto=` via react-router-dom's
// useSearchParams (the product panel's deep link) — it needs a Router in
// its tree even when this suite has nothing to do with the panel itself.
function renderFeedPage(initialEntries: string[] = ['/feed']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <FeedPage />
    </MemoryRouter>,
  )
}

describe('FeedPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the empty state once loaded with no matches', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([]))),
    )

    renderFeedPage()

    expect(await screen.findByText('Nenhum match ainda.')).toBeInTheDocument()
    expect(screen.getByText('Feed ao vivo')).toBeInTheDocument()
  })

  it('the "Atualizar" button reloads matches on demand (S7-02)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(jsonResponse([])))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderFeedPage()
    await screen.findByText('Nenhum match ainda.')
    // FeedPage also fetches rules/sources/recipients on mount, all through
    // the same global fetch mock — assert the increase, not an absolute count.
    const callsBeforeRefresh = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Atualizar' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches')).length,
      ).toBe(2),
    )
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
  })

  it('shows the Aurora Glow seal only for a match flagged as the lowest price ever (S7-06)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const cheapest = {
      id: 1,
      source_id: 1,
      rule_id: 1,
      message_text: 'iPhone barato',
      price_cents: 100_00,
      message_link: null,
      matched_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      deliveries: [],
      is_lowest_price_ever: true,
    }
    const notCheapest = { ...cheapest, id: 2, message_text: 'iPhone caro', is_lowest_price_ever: false }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([cheapest, notCheapest]))
        return Promise.resolve(jsonResponse([]))
      }),
    )

    renderFeedPage()

    await screen.findByText('iPhone barato')
    await screen.findByText('iPhone caro')
    // Only one seal, scoped to the flagged match's own card.
    expect(screen.getAllByText('Menor preço já visto')).toHaveLength(1)

    const cheapCard = screen.getByText('iPhone barato').closest('article')
    const expensiveCard = screen.getByText('iPhone caro').closest('article')
    expect(cheapCard?.className).toContain('match-card--aurora')
    expect(expensiveCard?.className).not.toContain('match-card--aurora')
  })

  it('resolves grouped_source_ids into source names for "Visto em" (S7-11)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const match = {
      id: 1,
      source_id: 1,
      rule_id: 1,
      message_text: 'RTX 5070 por R$ 4.000',
      price_cents: 400_000,
      message_link: null,
      matched_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      deliveries: [],
      is_lowest_price_ever: false,
      grouped_source_ids: [2, 3],
    }
    const sources = [
      { id: 1, name: 'Wolf Ofertas', telegram_chat_id: '-1001', active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'CMdias', telegram_chat_id: '-1002', active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 3, name: 'Menor Preço', telegram_chat_id: '-1003', active: true, created_at: '2026-01-01T00:00:00Z' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
        if (url.startsWith('/sources')) return Promise.resolve(jsonResponse(sources))
        return Promise.resolve(jsonResponse([]))
      }),
    )

    renderFeedPage()

    expect(await screen.findByText('Visto em: CMdias, Menor Preço')).toBeInTheDocument()
  })

  it('shows real numbers in the Resumo rail (S11-03)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const rules = [
      { id: 1, name: 'Regra A', include_terms: 'a', exclude_terms: null, max_price_cents: null, active: true, created_at: '2026-01-01T00:00:00Z', lowest_price_cents: null },
      { id: 2, name: 'Regra B', include_terms: 'b', exclude_terms: null, max_price_cents: null, active: true, created_at: '2026-01-01T00:00:00Z', lowest_price_cents: null },
    ]
    const matches = [
      {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'Produto A1',
        price_cents: 5000,
        message_link: null,
        matched_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        deliveries: [{ id: 1, recipient_id: 1, status: 'sent', delivered_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }],
        is_lowest_price_ever: false,
      },
      {
        id: 2,
        source_id: 1,
        rule_id: 1,
        message_text: 'Produto A2',
        price_cents: 3000,
        message_link: null,
        matched_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
      {
        id: 3,
        source_id: 1,
        rule_id: 2,
        message_text: 'Produto B1',
        price_cents: 9000,
        message_link: null,
        matched_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderFeedPage()
    await screen.findByText('Produto A1')

    // Sem filtro: os 3 matches contam, 1 entregue, menor preço R$ 30,00.
    // S14-07: scoped to the "Resumo" aside — the new "Resumo de hoje" tile
    // (barra lateral) also has a "Matches" label, for a different number.
    const resumoRail = document.querySelector('.feed-summary') as HTMLElement
    const matchesTile = within(resumoRail).getByText('Matches').closest('.feed-summary__tile')
    expect(matchesTile).toHaveTextContent('3')
    const sentTile = within(resumoRail).getByText('Enviados').closest('.feed-summary__tile')
    expect(sentTile).toHaveTextContent('1')
    const priceTile = within(resumoRail).getByText('Menor preço').closest('.feed-summary__tile')
    expect(priceTile).toHaveTextContent('R$ 30,00')
    // Nenhum contador existente conta mensagens (`vista` = matches persistidos
    // por par mensagem×regra), então não há tile "Mensagens lidas/vistas" —
    // e o Resumo nem consulta /metrics.
    expect(screen.queryByText(/Mensagens (lidas|vistas)/)).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/metrics'))).toBe(false)
  })

  it('filters both the grid and the Resumo rail by the selected rule (S11-03)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const rules = [
      { id: 1, name: 'Regra A', include_terms: 'a', exclude_terms: null, max_price_cents: null, active: true, created_at: '2026-01-01T00:00:00Z', lowest_price_cents: null },
      { id: 2, name: 'Regra B', include_terms: 'b', exclude_terms: null, max_price_cents: null, active: true, created_at: '2026-01-01T00:00:00Z', lowest_price_cents: null },
    ]
    const matches = [
      {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'Produto A1',
        price_cents: 5000,
        message_link: null,
        matched_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
      {
        id: 2,
        source_id: 1,
        rule_id: 2,
        message_text: 'Produto B1',
        price_cents: 9000,
        message_link: null,
        matched_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
        return Promise.resolve(jsonResponse([]))
      }),
    )
    const user = userEvent.setup()

    renderFeedPage()
    await screen.findByText('Produto A1')
    expect(screen.getByText('Produto B1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Regra A/ }))

    expect(screen.getByText('Produto A1')).toBeInTheDocument()
    expect(screen.queryByText('Produto B1')).not.toBeInTheDocument()
    const resumoRail = document.querySelector('.feed-summary') as HTMLElement
    const matchesTile = within(resumoRail).getByText('Matches').closest('.feed-summary__tile')
    expect(matchesTile).toHaveTextContent('1')
  })

  describe('product panel (S14-08, 07b)', () => {
    const match = {
      id: 1,
      source_id: 1,
      rule_id: 1,
      message_text: 'Placa de vídeo exemplo por R$ 5.749',
      price_cents: 574_900,
      message_link: null,
      matched_at: '2026-09-20T12:00:00Z',
      created_at: '2026-09-20T12:00:00Z',
      deliveries: [],
      is_lowest_price_ever: false,
      product_key: 'placa-video-exemplo',
    }
    const product = {
      product_key: 'placa-video-exemplo',
      title: 'Placa de vídeo exemplo',
      total_count: 1,
      sources: [{ id: 1, name: 'Loja Demo' }],
      first_seen_at: '2026-09-20T12:00:00Z',
      current_price_cents: 574_900,
      current_price_at: '2026-09-20T12:00:00Z',
      lowest_90d_cents: 574_900,
      average_30d_cents: 574_900,
      highest_90d_cents: 574_900,
      range: '90d',
      series: [{ date: '2026-09-20', price_cents: 574_900 }],
      postings: [],
    }

    function stubFetch() {
      vi.stubGlobal('EventSource', InertEventSource)
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input)
          if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
          if (url.startsWith('/products/placa-video-exemplo')) return Promise.resolve(jsonResponse(product))
          return Promise.resolve(jsonResponse([]))
        }),
      )
    }

    it('opens the panel from the card trigger and closes it from the × button', async () => {
      stubFetch()
      const user = userEvent.setup()
      renderFeedPage()

      await screen.findByText('Placa de vídeo exemplo por R$ 5.749')
      await user.click(screen.getByRole('button', { name: /Abrir produto/ }))

      expect(await screen.findByRole('heading', { name: 'Placa de vídeo exemplo' })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Fechar painel do produto' }))
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Placa de vídeo exemplo' })).not.toBeInTheDocument())
    })

    it('opens the panel straight from a `?produto=` deep link (survives F5)', async () => {
      stubFetch()
      renderFeedPage(['/feed?produto=placa-video-exemplo'])

      expect(await screen.findByRole('heading', { name: 'Placa de vídeo exemplo' })).toBeInTheDocument()
    })

    it('returns focus to the trigger that opened the panel once it closes', async () => {
      stubFetch()
      const user = userEvent.setup()
      renderFeedPage()

      await screen.findByText('Placa de vídeo exemplo por R$ 5.749')
      const trigger = screen.getByRole('button', { name: /Abrir produto/ })
      await user.click(trigger)
      await screen.findByRole('heading', { name: 'Placa de vídeo exemplo' })

      await user.click(screen.getByRole('button', { name: 'Fechar painel do produto' }))
      await waitFor(() => expect(trigger).toHaveFocus())
    })
  })
})

describe('FeedPage — barra lateral (S14-07, 06)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const rules = [
    {
      id: 1,
      name: 'RTX 5070 Ti',
      include_terms: 'rtx',
      exclude_terms: null,
      max_price_cents: null,
      target_price_cents: 5_800_00,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      lowest_price_cents: 5_749_00,
      snoozed_until: null,
    },
    {
      id: 2,
      name: 'Ryzen 7 9800X3D',
      include_terms: 'ryzen',
      exclude_terms: null,
      max_price_cents: null,
      target_price_cents: 2_050_00,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
      lowest_price_cents: 2_249_00,
      snoozed_until: null,
    },
  ]

  const snoozes = [
    {
      id: 10,
      scope: 'product',
      rule_id: null,
      product_key: 'corsair-32gb-ddr5',
      until: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      label: 'Corsair 32GB DDR5',
    },
  ]

  const digest = {
    enabled: true,
    send_at_local: '09:00',
    top_n: 5,
    mute_individual: false,
    next_run_at_utc: '2026-01-02T12:00:00Z',
    next_run_at_local: '2026-01-02 09:00',
    queue_count: 3,
    queue: [],
  }

  const feedSettings = { group_duplicates: true }

  function stubSidebarFetch(overrides: Record<string, () => Response> = {}) {
    vi.stubGlobal('EventSource', InertEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        for (const [prefix, respond] of Object.entries(overrides)) {
          if (url.startsWith(prefix)) return Promise.resolve(respond())
        }
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
        if (url.startsWith('/snoozes')) {
          if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
          return Promise.resolve(jsonResponse(snoozes))
        }
        if (url.startsWith('/digest')) return Promise.resolve(jsonResponse(digest))
        if (url.startsWith('/settings/feed')) return Promise.resolve(jsonResponse(feedSettings))
        return Promise.resolve(jsonResponse([]))
      }),
    )
  }

  it('lists every rule with a target price, "atingido" when the true lowest already reached it', async () => {
    stubSidebarFetch()
    renderFeedPage()

    await screen.findByText('Alvos de preço')
    // Scoped to `.feed-target` rows specifically — "RTX 5070 Ti" is also a
    // rule name in the unrelated "Filtrar por regra" list further down.
    const targetRows = document.querySelectorAll('.feed-target')
    const rtxTarget = [...targetRows].find((row) => row.textContent?.includes('RTX 5070 Ti')) as HTMLElement
    expect(within(rtxTarget).getByText('atingido')).toBeInTheDocument()

    const ryzenTarget = [...targetRows].find((row) => row.textContent?.includes('Ryzen 7 9800X3D')) as HTMLElement
    expect(within(ryzenTarget).getByText('falta 9%')).toBeInTheDocument()
  })

  it('lists active snoozes with a "Reativar" button that deletes the snooze', async () => {
    stubSidebarFetch()
    const user = userEvent.setup()
    renderFeedPage()

    await screen.findByText('Corsair 32GB DDR5')
    const fetchMock = vi.mocked(fetch)
    const callsBefore = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Reativar' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => String(input) === '/snoozes/10' && init?.method === 'DELETE'),
      ).toBe(true),
    )
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('the "Agrupar duplicatas" toggle reads the real setting and flips it on click', async () => {
    stubSidebarFetch()
    const user = userEvent.setup()
    renderFeedPage()

    const toggle = await screen.findByRole('button', { name: /Agrupar duplicatas/ })
    expect(toggle).toHaveTextContent('Agrupar duplicatas: ligado')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    let putBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/settings/feed') && init?.method === 'PUT') {
          putBody = init.body
          return Promise.resolve(jsonResponse({ group_duplicates: false }))
        }
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
        if (url.startsWith('/snoozes')) return Promise.resolve(jsonResponse(snoozes))
        if (url.startsWith('/digest')) return Promise.resolve(jsonResponse(digest))
        if (url.startsWith('/settings/feed')) return Promise.resolve(jsonResponse(feedSettings))
        return Promise.resolve(jsonResponse([]))
      }),
    )

    await user.click(toggle)

    await waitFor(() => expect(putBody).not.toBeNull())
    expect(JSON.parse(putBody as string)).toEqual({ group_duplicates: false })
  })

  it('shows the digest\'s real horário/itens/próximo envio, and the mute toggle flips mute_individual', async () => {
    stubSidebarFetch()
    const user = userEvent.setup()
    renderFeedPage()

    await screen.findByText('Digest diário')
    expect(screen.getByLabelText('Horário')).toHaveValue('09:00')
    expect(screen.getByLabelText('Itens')).toHaveValue('5')
    expect(screen.getByText(/Próximo envio: 2026-01-02 09:00/)).toBeInTheDocument()
    expect(screen.getByText(/3 itens na fila/)).toBeInTheDocument()

    let putBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/digest') && init?.method === 'PUT') {
          putBody = init.body
          return Promise.resolve(jsonResponse({ ...digest, mute_individual: true }))
        }
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
        if (url.startsWith('/snoozes')) return Promise.resolve(jsonResponse(snoozes))
        if (url.startsWith('/digest')) return Promise.resolve(jsonResponse(digest))
        if (url.startsWith('/settings/feed')) return Promise.resolve(jsonResponse(feedSettings))
        return Promise.resolve(jsonResponse([]))
      }),
    )

    await user.click(screen.getByRole('button', { name: /Silenciar pings individuais/ }))

    await waitFor(() => expect(putBody).not.toBeNull())
    expect(JSON.parse(putBody as string)).toMatchObject({ mute_individual: true })
  })

  it('"Resumo de hoje" counts real matches (not cards) and target hits for today only', async () => {
    const now = new Date()
    const todayIso = now.toISOString()
    const yesterdayIso = new Date(now.getTime() - 2 * 86_400_000).toISOString()

    stubSidebarFetch({
      '/matches': () =>
        jsonResponse([
          {
            id: 1,
            source_id: 1,
            rule_id: 1,
            message_text: 'RTX hoje',
            price_cents: 5_749_00,
            price_cash_cents: null,
            price_card_cents: null,
            message_link: null,
            matched_at: todayIso,
            created_at: todayIso,
            deliveries: [],
            is_lowest_price_ever: false,
            grouped_source_ids: null,
            product_key: 'rtx',
            sparkline: [],
            snoozed: false,
            target_price_cents: 5_800_00,
            target_hit: true,
            target_gap_pct: 0,
            seen_count: 3,
            grouped_match_ids: [1, 2, 3],
          },
          {
            id: 4,
            source_id: 1,
            rule_id: 2,
            message_text: 'Ryzen ontem',
            price_cents: 2_249_00,
            price_cash_cents: null,
            price_card_cents: null,
            message_link: null,
            matched_at: yesterdayIso,
            created_at: yesterdayIso,
            deliveries: [],
            is_lowest_price_ever: false,
            grouped_source_ids: null,
            product_key: 'ryzen',
            sparkline: [],
            snoozed: false,
            target_price_cents: 2_050_00,
            target_hit: false,
            target_gap_pct: 9,
            seen_count: 1,
            grouped_match_ids: [4],
          },
        ]),
    })
    renderFeedPage()

    await screen.findByText('RTX hoje')
    const resumoHoje = screen.getByText('Resumo de hoje').closest('.feed-today') as HTMLElement
    expect(within(resumoHoje).getByText('Matches').nextElementSibling).toHaveTextContent('3')
    expect(within(resumoHoje).getByText('Duplicatas unidas').nextElementSibling).toHaveTextContent('2')
    expect(within(resumoHoje).getByText('Alvos atingidos').nextElementSibling).toHaveTextContent('1')
    expect(within(resumoHoje).getByText('Silenciados').nextElementSibling).toHaveTextContent('1')
  })
})
