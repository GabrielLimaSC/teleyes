import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORICO_FILTERS_STORAGE_KEY, HistoricoPage, parseStoredHistoricoFilters, toApiFilters } from './HistoricoPage'
import type { FilterForm } from './HistoricoPage'

// S14-08 parte 2 (rodada 2): HistoricoPage now reads `csrfToken` from
// `useAuth()` too (the panel's "Definir alvo"/"Silenciar" actions) — same
// stub every other authenticated-page suite already uses (FeedPage.test.tsx,
// SaudePage.test.tsx), preserving every other real export
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

// S14-08: HistoricoPage now reads/writes `?produto=` via react-router-dom's
// useSearchParams (the product panel's deep link) — it needs a Router in
// its tree even when a given test has nothing to do with the panel itself.
function renderHistoricoPage() {
  return render(
    <MemoryRouter>
      <HistoricoPage />
    </MemoryRouter>,
  )
}

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

  // S14-13: `parseOptionalPriceInput` replaces `Math.round(Number(x) * 100)`
  // — that read the pt-BR thousands dot as a decimal point ("5.749" silently
  // became 575 cents instead of 574900).
  it('reads the pt-BR thousands dot correctly — "5.749" is R$ 5.749, never R$ 5,75', () => {
    expect(toApiFilters({ ...EMPTY, minPriceReais: '5.749' })).toEqual({ minPriceCents: 574_900 })
    expect(toApiFilters({ ...EMPTY, minPriceReais: '5.749' })).not.toEqual({ minPriceCents: 575 })
  })

  it('leaves an unparseable, non-blank price filter out of the query instead of sending NaN', () => {
    expect(toApiFilters({ ...EMPTY, minPriceReais: 'abc', maxPriceReais: '5,749' })).toEqual({})
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
    // S15-06: filters now persist to sessionStorage — without this, a filter
    // applied by one test would leak into the next one's first render.
    window.sessionStorage.clear()
  })

  // S14-07 revisão 2: an implicit label-wraps-select association computes
  // its accessible name from the label's text concatenated with EVERY
  // option (not just the selected one) — harmless with a handful of items,
  // but with dozens of real rules/sources/recipients (production-realistic,
  // per Gabriel's own data) the resulting name balloons into an
  // indistinguishable blob, and `getByLabel('Regra')` (a screen reader,
  // Playwright, or Testing Library itself) can resolve the WRONG combobox.
  // `aria-label` pins each select's own accessible name to its short, real
  // label regardless of option count.
  it('keeps "Regra"/"Fonte"/"Destinatário" as distinct accessible names with many, similarly-prefixed options', async () => {
    const rules = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `Regra item-${i}`,
      include_terms: `item${i}`,
      exclude_terms: null,
      max_price_cents: null,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }))
    const sources = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `Fonte item-${i}`,
      telegram_chat_id: `chat-${i}`,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }))
    const recipients = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: `Dest item-${i}`,
      telegram_chat_id: `dest-${i}`,
      allowlisted: true,
      active: true,
      created_at: '2026-01-01T00:00:00Z',
    }))
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/rules')) return Promise.resolve(jsonResponse(rules))
      if (url.startsWith('/sources')) return Promise.resolve(jsonResponse(sources))
      if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse(recipients))
      if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([]))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderHistoricoPage()
    await waitFor(() => expect(screen.getByRole('option', { name: 'Regra item-0' })).toBeInTheDocument())

    // Each combobox resolves uniquely by its own short label — never 2 or 3
    // elements, and never the wrong one (asserted via `selector: 'select'`
    // plus a direct element-identity check against each field's own select).
    const ruleSelect = screen.getByLabelText('Regra', { selector: 'select' })
    const sourceSelect = screen.getByLabelText('Fonte', { selector: 'select' })
    const recipientSelect = screen.getByLabelText('Destinatário', { selector: 'select' })
    expect(ruleSelect).not.toBe(sourceSelect)
    expect(ruleSelect).not.toBe(recipientSelect)
    expect(sourceSelect).not.toBe(recipientSelect)
    expect(within(ruleSelect).getByRole('option', { name: 'Regra item-0' })).toBeInTheDocument()
    expect(within(sourceSelect).getByRole('option', { name: 'Fonte item-0' })).toBeInTheDocument()
    expect(within(recipientSelect).getByRole('option', { name: 'Dest item-0' })).toBeInTheDocument()
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

    renderHistoricoPage()

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

    renderHistoricoPage()

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

    renderHistoricoPage()

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

    const { container } = renderHistoricoPage()
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

    renderHistoricoPage()
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

    renderHistoricoPage()
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

    renderHistoricoPage()
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

    renderHistoricoPage()
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

    renderHistoricoPage()
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

    renderHistoricoPage()
    await screen.findByText('Nenhum match encontrado com esses filtros.')

    expect(screen.queryByRole('button', { name: 'Aplicar filtros' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Atualizar' })).toBeInTheDocument()
  })

  it('shows a pt-BR error under an unparseable price filter, visibly, never silently (S14-13)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([]))),
    )
    const user = userEvent.setup()

    renderHistoricoPage()
    await screen.findByText('Nenhum match encontrado com esses filtros.')

    await user.type(screen.getByLabelText('Preço mínimo (R$)'), '5,749')

    expect(
      await screen.findByText('Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Preço mínimo (R$)')).toHaveAttribute('aria-invalid', 'true')
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

    renderHistoricoPage()

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
      renderHistoricoPage()

      const link = await screen.findByRole('link', { name: 'Abrir promoção: Notebook gamer com link' })
      expect(link).toHaveAttribute('href', 'https://t.me/c/123456/77')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link).toHaveTextContent('Abrir promoção')
    })

    it('a row without a link says so, with the reason, and offers no dead link', async () => {
      stubFetch()
      renderHistoricoPage()

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
      renderHistoricoPage()
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

  describe('"Abrir produto" trigger and panel (S14-08, 07b)', () => {
    function stubFetchWithProductRow(productKey: string | null) {
      const match = {
        id: 1,
        source_id: 1,
        rule_id: 1,
        message_text: 'Placa de vídeo exemplo por R$ 5.749',
        price_cents: 574_900,
        price_cash_cents: null,
        price_card_cents: null,
        message_link: null,
        matched_at: '2026-09-20T12:00:00Z',
        created_at: '2026-09-20T12:00:00Z',
        deliveries: [],
        is_lowest_price_ever: false,
        product_key: productKey,
      }
      const product = {
        product_key: productKey,
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
      return vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/rules')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/sources')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/recipients')) return Promise.resolve(jsonResponse([]))
        if (url.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
        if (url.startsWith(`/products/${productKey}`)) return Promise.resolve(jsonResponse(product))
        throw new Error(`unexpected fetch: ${url}`)
      })
    }

    it('shows the trigger and a clickable title only for a row with a product_key', async () => {
      vi.stubGlobal('fetch', stubFetchWithProductRow('placa-video-exemplo'))
      renderHistoricoPage()

      await screen.findByText('Placa de vídeo exemplo por R$ 5.749')
      expect(screen.getByRole('button', { name: /Abrir produto/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Placa de vídeo exemplo por R$ 5.749' })).toBeInTheDocument()
    })

    it('has no trigger and a plain (non-button) title without a product_key', async () => {
      vi.stubGlobal('fetch', stubFetchWithProductRow(null))
      renderHistoricoPage()

      await screen.findByText('Placa de vídeo exemplo por R$ 5.749')
      expect(screen.queryByRole('button', { name: /Abrir produto/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Placa de vídeo exemplo por R$ 5.749' })).not.toBeInTheDocument()
    })

    it('opens the product panel from the trigger, which fetches and shows the product', async () => {
      vi.stubGlobal('fetch', stubFetchWithProductRow('placa-video-exemplo'))
      const user = userEvent.setup()
      renderHistoricoPage()

      await screen.findByText('Placa de vídeo exemplo por R$ 5.749')
      await user.click(screen.getByRole('button', { name: /Abrir produto/ }))

      expect(await screen.findByRole('heading', { name: 'Placa de vídeo exemplo' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Fechar painel do produto' }))
    })
  })

  // S15-06: "aplico um filtro em Histórico, vou pro Feed, volto e já tenho
  // que colocar de novo" — the filters now live in sessionStorage
  // (`HISTORICO_FILTERS_STORAGE_KEY`), not just component state, so a fresh
  // mount of the page (what happens on every SPA navigation, and on F5)
  // restores them instead of starting from `EMPTY_FILTERS`.
  describe('persisted filters (S15-06)', () => {
    function stubEmptyFetch() {
      const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(jsonResponse([])))
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('restores a filter left by a previous mount (simulating navigating back via NavCapsule)', async () => {
      const firstFetchMock = stubEmptyFetch()
      const first = renderHistoricoPage()
      const ruleSelect = await screen.findByLabelText('Regra')
      // No rule options loaded here (empty list), but the select itself
      // still carries whatever `form.ruleId` was set to underneath, and
      // that's what the query below asserts.
      await screen.findByText('Nenhum match encontrado com esses filtros.')

      await userEvent.setup().type(screen.getByLabelText('Preço mínimo (R$)'), '100')
      await waitFor(() => {
        const last = firstFetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches')).at(-1)
        expect(String(last?.[0])).toBe('/matches?min_price_cents=10000')
      })
      expect(ruleSelect).toBeInTheDocument()

      // A second mount — same tab, no explicit prop carrying the filter —
      // is exactly what happens navigating Feed -> Histórico via NavCapsule
      // (which links bare, no query string) or reloading (F5). Unmounting
      // the first render first is what makes this an honest remount rather
      // than two copies of the page coexisting in the same DOM.
      first.unmount()
      const fetchMock = stubEmptyFetch()
      renderHistoricoPage()

      expect(await screen.findByLabelText('Preço mínimo (R$)')).toHaveValue('100')
      await waitFor(() => {
        const last = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/matches')).at(-1)
        expect(String(last?.[0])).toBe('/matches?min_price_cents=10000')
      })
    })

    it('"Limpar filtros" also clears what is stored — a later mount stays empty', async () => {
      stubEmptyFetch()
      const user = userEvent.setup()
      const first = renderHistoricoPage()
      await screen.findByText('Nenhum match encontrado com esses filtros.')

      await user.type(screen.getByLabelText('Preço mínimo (R$)'), '100')
      expect(screen.getByLabelText('Preço mínimo (R$)')).toHaveValue('100')
      expect(window.sessionStorage.getItem(HISTORICO_FILTERS_STORAGE_KEY)).not.toBeNull()

      await user.click(screen.getByRole('button', { name: 'Limpar filtros' }))
      expect(screen.getByLabelText('Preço mínimo (R$)')).toHaveValue('')
      expect(window.sessionStorage.getItem(HISTORICO_FILTERS_STORAGE_KEY)).toBeNull()

      first.unmount()
      renderHistoricoPage()
      expect(await screen.findByLabelText('Preço mínimo (R$)')).toHaveValue('')
    })

    it('works with no persistence when storage is blocked (S12-04 contract), no crash', async () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError')
      })
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError')
      })
      stubEmptyFetch()
      const user = userEvent.setup()

      renderHistoricoPage()
      await screen.findByText('Nenhum match encontrado com esses filtros.')

      await expect(user.type(screen.getByLabelText('Preço mínimo (R$)'), '100')).resolves.not.toThrow()
      expect(screen.getByLabelText('Preço mínimo (R$)')).toHaveValue('100')

      getItemSpy.mockRestore()
      setItemSpy.mockRestore()
    })
  })
})

describe('parseStoredHistoricoFilters (S15-06)', () => {
  const EMPTY: FilterForm = {
    ruleId: '',
    sourceId: '',
    recipientId: '',
    minPriceReais: '',
    maxPriceReais: '',
    deliveryStatus: '',
    sort: '',
  }

  it('parses a complete, well-formed stored value', () => {
    const stored: FilterForm = { ...EMPTY, ruleId: '3', minPriceReais: '100', sort: 'price_asc' }
    expect(parseStoredHistoricoFilters(JSON.stringify(stored))).toEqual(stored)
  })

  it('merges a partial value (missing fields) with EMPTY_FILTERS', () => {
    expect(parseStoredHistoricoFilters(JSON.stringify({ ruleId: '5' }))).toEqual({ ...EMPTY, ruleId: '5' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseStoredHistoricoFilters('{not json')).toBeNull()
  })

  it('returns null for a JSON value that is not a plain object (array, string, number, null)', () => {
    expect(parseStoredHistoricoFilters('[]')).toBeNull()
    expect(parseStoredHistoricoFilters('"abc"')).toBeNull()
    expect(parseStoredHistoricoFilters('42')).toBeNull()
    expect(parseStoredHistoricoFilters('null')).toBeNull()
  })

  it('returns null when an unknown field is present', () => {
    expect(parseStoredHistoricoFilters(JSON.stringify({ ruleId: '1', bogusField: 'x' }))).toBeNull()
  })

  it('returns null when a known field has the wrong type', () => {
    expect(parseStoredHistoricoFilters(JSON.stringify({ ruleId: 1 }))).toBeNull()
    expect(parseStoredHistoricoFilters(JSON.stringify({ sourceId: null }))).toBeNull()
    expect(parseStoredHistoricoFilters(JSON.stringify({ sort: true }))).toBeNull()
  })

  it('returns null when sort is a string outside the 3 real options', () => {
    expect(parseStoredHistoricoFilters(JSON.stringify({ sort: 'price_random' }))).toBeNull()
  })

  it('accepts a stale (no-longer-existing) rule/source/recipient id as plain valid data', () => {
    // S15-06: existence is not this function's job — a deleted rule's id is
    // just a string like any other; the page already handles it safely (the
    // <select> simply has no matching <option>, and the API returns no rows).
    expect(parseStoredHistoricoFilters(JSON.stringify({ ruleId: '999999' }))).toEqual({
      ...EMPTY,
      ruleId: '999999',
    })
  })
})
