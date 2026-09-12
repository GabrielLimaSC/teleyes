import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricoPage, toApiFilters } from './HistoricoPage'
import type { FilterForm } from './HistoricoPage'

const EMPTY: FilterForm = {
  ruleId: '',
  sourceId: '',
  recipientId: '',
  minPriceReais: '',
  maxPriceReais: '',
  deliveryStatus: '',
}

describe('toApiFilters', () => {
  it('is empty for an empty form', () => {
    expect(toApiFilters(EMPTY)).toEqual({})
  })

  it('converts reais to integer cents', () => {
    expect(toApiFilters({ ...EMPTY, minPriceReais: '19.90', maxPriceReais: '3899' })).toEqual({
      minPriceCents: 1990,
      maxPriceCents: 389_900,
    })
  })

  it('parses the numeric ids and forwards the delivery status as-is', () => {
    expect(
      toApiFilters({ ...EMPTY, ruleId: '1', sourceId: '2', recipientId: '3', deliveryStatus: 'sent' }),
    ).toEqual({ ruleId: 1, sourceId: 2, recipientId: 3, deliveryStatus: 'sent' })
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

describe('HistoricoPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refetches with the rule filter when the selection changes', async () => {
    const rule = {
      id: 1,
      name: 'iPhone',
      include_terms: 'iphone',
      exclude_terms: null,
      max_price_cents: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([rule]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<HistoricoPage />)

    const ruleSelect = await screen.findByLabelText('Regra')
    await waitFor(() => expect(screen.getByRole('option', { name: 'iPhone' })).toBeInTheDocument())

    await user.selectOptions(ruleSelect, '1')

    await waitFor(() => {
      const matchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches'))
      expect(matchCalls.at(-1)?.[0]).toBe('/matches?rule_id=1')
    })
  })
})
