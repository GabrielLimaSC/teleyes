import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedPage } from './FeedPage'

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
    const matchesTile = screen.getByText('Matches').closest('.feed-summary__tile')
    expect(matchesTile).toHaveTextContent('3')
    const sentTile = screen.getByText('Enviados').closest('.feed-summary__tile')
    expect(sentTile).toHaveTextContent('1')
    const priceTile = screen.getByText('Menor preço').closest('.feed-summary__tile')
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
    const matchesTile = screen.getByText('Matches').closest('.feed-summary__tile')
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
