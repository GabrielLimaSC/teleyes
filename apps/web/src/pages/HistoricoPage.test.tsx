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
  sort: '',
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

  it('forwards sort only when a direction is chosen (S7-07)', () => {
    expect(toApiFilters(EMPTY)).toEqual({})
    expect(toApiFilters({ ...EMPTY, sort: 'price_asc' })).toEqual({ sort: 'price_asc' })
    expect(toApiFilters({ ...EMPTY, sort: 'price_desc' })).toEqual({ sort: 'price_desc' })
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

  it('offers and forwards the historical (no retroactive alert) delivery filter (S6-02)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<HistoricoPage />)

    const deliverySelect = await screen.findByLabelText('Entrega')
    expect(screen.getByRole('option', { name: 'Histórico — sem alerta' })).toBeInTheDocument()

    await user.selectOptions(deliverySelect, 'historical')

    await waitFor(() => {
      const matchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches'))
      expect(matchCalls.at(-1)?.[0]).toBe('/matches?delivery_status=historical')
    })
  })

  it('offers and forwards the price sort control (S7-07)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<HistoricoPage />)

    const sortSelect = await screen.findByLabelText('Ordenar por')
    expect(screen.getByRole('option', { name: 'Menor preço primeiro' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Maior preço primeiro' })).toBeInTheDocument()

    await user.selectOptions(sortSelect, 'price_asc')
    await waitFor(() => {
      const matchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches'))
      expect(matchCalls.at(-1)?.[0]).toBe('/matches?sort=price_asc')
    })

    await user.selectOptions(sortSelect, 'price_desc')
    await waitFor(() => {
      const matchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches'))
      expect(matchCalls.at(-1)?.[0]).toBe('/matches?sort=price_desc')
    })
  })

  it('shows a "Resultados" header repeating the current sort label (S10-07)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    const { container } = render(<HistoricoPage />)
    // Scoped to the "Resultados" header itself — "Ordenar por" always
    // renders all 3 sort labels as <option> text too, so an unscoped query
    // would find two matches for the same label once one is selected.
    const resultsLabel = () => container.querySelector('.crud-section-row p')

    expect(await screen.findByRole('heading', { name: 'Resultados' })).toBeInTheDocument()
    expect(resultsLabel()).toHaveTextContent('Mais recentes primeiro')

    const sortSelect = screen.getByLabelText('Ordenar por')
    await user.selectOptions(sortSelect, 'price_asc')

    // Both places update — the select itself and the repeated label above
    // the results — using the exact same SORT_OPTIONS labels, never a
    // second hardcoded copy that could drift out of sync.
    await waitFor(() => expect(resultsLabel()).toHaveTextContent('Menor preço primeiro'))
  })

  it('the "Atualizar" button reloads matches on demand without changing filters (S7-02)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<HistoricoPage />)
    await screen.findByText('Nenhum match encontrado com esses filtros.')

    await user.click(screen.getByRole('button', { name: 'Atualizar' }))

    await waitFor(() => {
      const matchCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches'))
      expect(matchCalls).toHaveLength(2)
      expect(matchCalls[1][0]).toBe('/matches')
    })
  })
})
