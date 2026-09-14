import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedPage } from './FeedPage'

class InertEventSource {
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
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

    render(<FeedPage />)

    expect(await screen.findByText('Nenhum match ainda.')).toBeInTheDocument()
    expect(screen.getByText('Feed ao vivo')).toBeInTheDocument()
  })

  it('the "Atualizar" button reloads matches on demand (S7-02)', async () => {
    vi.stubGlobal('EventSource', InertEventSource)
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(jsonResponse([])))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<FeedPage />)
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

    render(<FeedPage />)

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

    render(<FeedPage />)

    expect(await screen.findByText('Visto em: CMdias, Menor Preço')).toBeInTheDocument()
  })
})
