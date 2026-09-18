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

  it('repeats the current sort label next to the result count (S10-07, S11-04)', async () => {
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
    // S11-04: the S10-05/S10-07 "Resultados" header moved into the page
    // header's subtitle ("N resultados · <sort label>", matching the S11
    // concept) — "Ordenar por" always renders all 3 sort labels as <option>
    // text too, so scoping to the subtitle avoids matching those.
    const subtitle = () => container.querySelector('.historico-page__subtitle')

    expect(await screen.findByText('Nenhum match encontrado com esses filtros.')).toBeInTheDocument()
    expect(subtitle()).toHaveTextContent('mais recentes primeiro')

    const sortSelect = screen.getByLabelText('Ordenar por')
    await user.selectOptions(sortSelect, 'price_asc')

    // Both places update — the select itself and the repeated label in the
    // subtitle — using the exact same SORT_OPTIONS labels, never a second
    // hardcoded copy that could drift out of sync.
    await waitFor(() => expect(subtitle()).toHaveTextContent('menor preço primeiro'))
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

  it('computes the 4 stat tiles from the real loaded matches, client-side (S11-04)', async () => {
    const rule = {
      id: 1,
      name: 'Regra CSV',
      include_terms: 'produto',
      exclude_terms: null,
      max_price_cents: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }
    const matches = [
      {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'produto barato',
        price_cents: 1000,
        price_cash_cents: null,
        price_card_cents: null,
        message_link: null,
        matched_at: '2026-01-01T10:00:00Z',
        created_at: '2026-01-01T10:00:00Z',
        deliveries: [{ id: 1, recipient_id: 1, status: 'sent', delivered_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' }],
        is_lowest_price_ever: false,
      },
      {
        id: 2,
        source_id: 1,
        rule_id: 1,
        message_text: 'produto caro',
        price_cents: 3000,
        price_cash_cents: null,
        price_card_cents: null,
        message_link: null,
        matched_at: '2026-01-01T11:00:00Z',
        created_at: '2026-01-01T11:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
      {
        id: 3,
        source_id: 1,
        rule_id: 1,
        message_text: 'produto sem preco',
        price_cents: null,
        price_cash_cents: null,
        price_card_cents: null,
        message_link: null,
        matched_at: '2026-01-01T12:00:00Z',
        created_at: '2026-01-01T12:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([rule]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<HistoricoPage />)
    await screen.findByText('produto barato')

    // 3 matches, média (1000+3000)/2=2000 (ignora o sem preço), menor 1000,
    // 1 entrega com status sent.
    const countTile = screen.getByText('Matches no período').closest('.historico-stats__tile')
    expect(countTile).toHaveTextContent('3')
    const avgTile = screen.getByText('Preço médio').closest('.historico-stats__tile')
    expect(avgTile).toHaveTextContent('R$ 20,00')
    const lowestTile = screen.getByText('Menor preço').closest('.historico-stats__tile')
    expect(lowestTile).toHaveTextContent('R$ 10,00')
    const deliveredTile = screen.getByText('Entregas feitas').closest('.historico-stats__tile')
    expect(deliveredTile).toHaveTextContent('1')
  })

  it('exports a CSV whose values match what is on screen (S11-04)', async () => {
    const rule = {
      id: 1,
      name: 'Regra CSV',
      include_terms: 'produto',
      exclude_terms: null,
      max_price_cents: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }
    const source = { id: 1, name: 'Fonte CSV', telegram_chat_id: '-1001', active: true, created_at: '2026-01-01T00:00:00Z' }
    const matches = [
      {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'produto csv',
        price_cents: 5000,
        price_cash_cents: null,
        price_card_cents: null,
        message_link: null,
        matched_at: '2026-01-01T10:00:00Z',
        created_at: '2026-01-01T10:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
      },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([rule]))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([source]))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    let capturedBlob: Blob | null = null
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn((blob: Blob) => {
          capturedBlob = blob
          return 'blob:test'
        }),
        revokeObjectURL: vi.fn(),
      }),
    )
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const user = userEvent.setup()

    render(<HistoricoPage />)
    await screen.findByText('produto csv')

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(capturedBlob).not.toBeNull()
    const text = await capturedBlob!.text()
    expect(text).toContain('Produto,Regra,Fonte,Hora,Preço,Entrega')
    expect(text).toContain('produto csv')
    expect(text).toContain('Regra CSV')
    expect(text).toContain('Fonte CSV')
    expect(text).toContain('50,00')
    clickSpy.mockRestore()
  })
})
