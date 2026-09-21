import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FontesPage } from './FontesPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

const source = { id: 1, name: 'Fonte TZ', telegram_chat_id: '-1001', active: true, created_at: '2026-01-01T00:00:00' }

const match = (id: number, matchedAt: string) => ({
  id,
  source_id: 1,
  rule_id: 1,
  message_text: 'promo',
  price_cents: 1000,
  price_cash_cents: null,
  price_card_cents: null,
  message_link: null,
  matched_at: matchedAt,
  created_at: matchedAt,
  deliveries: [],
  is_lowest_price_ever: false,
  grouped_source_ids: null,
})

function stubApi(matches: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([source]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

describe('FontesPage "Último match" (S13-01)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the last match in local time: 01:43 UTC is 22:43 the day before in America/Sao_Paulo', async () => {
    stubApi([match(1, '2026-09-20T01:43:00')])

    render(<FontesPage />)

    const cell = (await screen.findByText('Fonte TZ')).closest('tr')!.querySelector('[data-label="Último match"]')
    expect(cell).toHaveTextContent('19/09/2026')
    expect(cell).toHaveTextContent('22:43')
  })

  it('picks the latest match by instant, not by string order', async () => {
    // As strings, "2026-09-20T01:00:00Z" sorts after "2026-09-19T23:00:00-03:00"
    // ('20' > '19'), but the second is the later instant (02:00 UTC).
    stubApi([match(1, '2026-09-20T01:00:00Z'), match(2, '2026-09-19T23:00:00-03:00')])

    render(<FontesPage />)

    const cell = (await screen.findByText('Fonte TZ')).closest('tr')!.querySelector('[data-label="Último match"]')
    expect(cell).toHaveTextContent('23:00:00')
  })

  it('says so when the source has no match yet', async () => {
    stubApi([])

    render(<FontesPage />)

    expect(await screen.findByText('Nenhum match ainda')).toBeInTheDocument()
  })
})
