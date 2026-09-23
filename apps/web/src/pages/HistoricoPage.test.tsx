import { render, screen, waitFor, within } from '@testing-library/react'
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
    vi.useRealTimers()
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
    expect(text).toContain('Produto,Regra,Fonte,Hora,Preço,Detalhe do preço,Entrega,Para')
    expect(text).toContain('produto csv')
    expect(text).toContain('Regra CSV')
    expect(text).toContain('Fonte CSV')
    expect(text).toContain('50,00')
    clickSpy.mockRestore()
  })

  it('shows the row time in local time and exports the CSV time unambiguously (S13-01)', async () => {
    // 01:43 UTC on 20 Sep = 22:43 on 19 Sep in America/Sao_Paulo (vitest.config.ts pins TZ).
    // The API used to send it with no zone, and the page read that as local 01:43.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 19, 23, 0, 0))
    const rule = {
      id: 1,
      name: 'Regra TZ',
      include_terms: 'produto',
      exclude_terms: null,
      max_price_cents: null,
      active: true,
      created_at: '2026-01-01T00:00:00',
    }
    const match = {
      id: 1,
      source_id: 1,
      rule_id: 1,
      message_text: 'produto tz',
      price_cents: 5000,
      price_cash_cents: null,
      price_card_cents: null,
      message_link: null,
      matched_at: '2026-09-20T01:43:00',
      created_at: '2026-09-20T01:43:00',
      deliveries: [],
      is_lowest_price_ever: false,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([rule]))
        if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
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
    let downloadName = ''
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download
    })
    const user = userEvent.setup({ advanceTimers: () => {} })

    render(<HistoricoPage />)
    await screen.findByText('produto tz')

    const row = screen.getByText('produto tz').closest('.historico-table__row') as HTMLElement
    expect(within(row).getByText('Hoje, 22:43')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))

    const csv = await capturedBlob!.text()
    // Absolute local date and time, quoted because it contains a comma.
    expect(csv).toContain('"19/09/2026, 22:43:00"')
    expect(csv).not.toContain('Hoje')
    // The file is named by the LOCAL day (19), not the UTC day (20).
    expect(downloadName).toBe('historico-teleyes-2026-09-19.csv')
    clickSpy.mockRestore()
  })

  it('shows cash/card prices and the recipients on the row, and the CSV carries the exact same texts (S11-04 review)', async () => {
    const rule = {
      id: 1,
      name: 'Regra RTX',
      include_terms: 'rtx',
      exclude_terms: null,
      max_price_cents: 500_000,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }
    const source = { id: 1, name: 'Fonte RTX', telegram_chat_id: '-1001', active: true, created_at: '2026-01-01T00:00:00Z' }
    const recipient = { id: 7, name: 'Gabriel', telegram_chat_id: '901', allowlisted: true, active: true, created_at: '2026-01-01T00:00:00Z' }
    const matches = [
      {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'rtx 5070 a vista no pix',
        price_cents: 451_600,
        price_cash_cents: 451_600,
        price_card_cents: 499_900,
        message_link: null,
        matched_at: '2026-01-01T10:00:00Z',
        created_at: '2026-01-01T10:00:00Z',
        deliveries: [
          { id: 1, recipient_id: 7, status: 'sent', delivered_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' },
        ],
        is_lowest_price_ever: true,
        grouped_source_ids: null,
        product_key: null,
        sparkline: [],
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([rule]))
        if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([source]))
        if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([recipient]))
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
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
    await screen.findByText('rtx 5070 a vista no pix')

    // On screen: cash price leads, card price on the "À vista · Cartão" line
    // (same lines MatchCard shows), lowest-ever note, and "Para: <recipient>".
    // Scoped to the row: the stat tiles above also show R$ 4.516,00.
    const row = screen.getByText('rtx 5070 a vista no pix').closest('.historico-table__row') as HTMLElement
    const priceLine = row.querySelector('.historico-table__price') as HTMLElement
    expect(priceLine).toHaveTextContent('R$ 4.516,00')
    const cardLine = within(row).getByText('À vista · Cartão R$ 4.999,00')
    expect(within(row).getByText('Menor já visto')).toBeInTheDocument()
    const recipientLine = within(row).getByText('Para: Gabriel')

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))

    const text = await capturedBlob!.text()
    // The CSV repeats those exact strings, not the raw API fields.
    // (comma-bearing fields are quoted, hence the quotes around the price)
    // (textContent, not a literal: pt-BR currency uses a non-breaking space)
    expect(text).toContain(`"${priceLine.textContent}"`)
    expect(text).toContain(`"${cardLine.textContent} · Menor já visto"`)
    expect(text).toContain(`,Entregue,${recipientLine.textContent!.replace('Para: ', '')}`)
    clickSpy.mockRestore()
  })

  it('has no separate "Aplicar filtros" button — filters apply on change, "Atualizar" reloads (S11-04 review)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([]))),
    )

    render(<HistoricoPage />)
    await screen.findByText('Nenhum match encontrado com esses filtros.')

    expect(screen.queryByRole('button', { name: 'Aplicar filtros' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Atualizar' })).toBeInTheDocument()
  })

  it('a title long enough to be clipped by the 2-line clamp keeps its full text in a Tooltip (S11-04 review)', async () => {
    const longText = `rtx ${'placa de video gamer muito potente '.repeat(4)}fim`
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/matches')) {
          return Promise.resolve(
            jsonResponse([
              {
                id: 1,
                source_id: 1,
                rule_id: 1,
                message_text: longText,
                price_cents: 100_000,
                price_cash_cents: null,
                price_card_cents: null,
                message_link: null,
                matched_at: '2026-01-01T10:00:00Z',
                created_at: '2026-01-01T10:00:00Z',
                deliveries: [],
                is_lowest_price_ever: false,
                grouped_source_ids: null,
                product_key: null,
                sparkline: [],
              },
            ]),
          )
        }
        return Promise.resolve(jsonResponse([]))
      }),
    )

    render(<HistoricoPage />)

    // The tooltip bubble carries the untouched text; the row title is the
    // (possibly clipped) face of it.
    expect(await screen.findByRole('tooltip')).toHaveTextContent(longText)
  })

  describe('"Abrir promoção" on every row (S13-03)', () => {
    const baseMatch = {
      source_id: 1,
      rule_id: 1,
      price_cents: 100_000,
      price_cash_cents: null,
      price_card_cents: null,
      matched_at: '2026-01-01T10:00:00Z',
      created_at: '2026-01-01T10:00:00Z',
      deliveries: [],
      is_lowest_price_ever: false,
      grouped_source_ids: null,
      product_key: null,
      sparkline: [],
    }
    const matches = [
      { ...baseMatch, id: 1, message_text: 'Notebook gamer com link', message_link: 'https://t.me/c/123456/77' },
      { ...baseMatch, id: 2, message_text: 'Fone antigo do grupo', message_link: null },
    ]

    function stubFetch() {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          if (String(input).startsWith('/matches')) return Promise.resolve(jsonResponse(matches))
          return Promise.resolve(jsonResponse([]))
        }),
      )
    }

    it('links the row to the real message in a new tab, named after the row', async () => {
      stubFetch()
      render(<HistoricoPage />)

      const link = await screen.findByRole('link', { name: 'Abrir promoção: Notebook gamer com link' })
      expect(link).toHaveAttribute('href', 'https://t.me/c/123456/77')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link).toHaveTextContent('Abrir promoção')
    })

    it('a row without a link says so, with the reason, and offers no dead link', async () => {
      stubFetch()
      render(<HistoricoPage />)

      await screen.findByText('Fone antigo do grupo')
      // Exactly one link: the row that has one. The other is explicit text.
      expect(screen.getAllByRole('link')).toHaveLength(1)
      expect(screen.queryByRole('link', { name: /Fone antigo do grupo/ })).not.toBeInTheDocument()
      const noLink = screen.getByText('Sem link', { exact: false })
      expect(noLink).toHaveAttribute('title', 'o Telegram não forneceu o endereço desta mensagem')
      expect(noLink).toHaveTextContent('Sem link: o Telegram não forneceu o endereço desta mensagem')
    })

    it('the CSV carries the link column, empty when there is no link', async () => {
      stubFetch()
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
      await screen.findByText('Fone antigo do grupo')

      await user.click(screen.getByRole('button', { name: 'Exportar CSV' }))

      const lines = (await capturedBlob!.text()).replace('\uFEFF', '').split('\r\n')
      expect(lines[0].split(',').at(-1)).toBe('Link')
      const withLink = lines.find((line) => line.startsWith('Notebook gamer com link'))!
      const withoutLink = lines.find((line) => line.startsWith('Fone antigo do grupo'))!
      expect(withLink.endsWith(',https://t.me/c/123456/77')).toBe(true)
      expect(withoutLink.endsWith(',')).toBe(true)
      clickSpy.mockRestore()
    })
  })
})
