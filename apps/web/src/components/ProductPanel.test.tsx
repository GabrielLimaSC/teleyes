import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductPanel } from './ProductPanel'
import type { Product } from '../api/types'
import type { EditableMatch } from '../api/matches'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ csrfToken: 'csrf-test' }),
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buildProduct(overrides: Partial<Product> = {}): Product {
  return {
    product_key: 'placa-video-exemplo-rtx',
    title: 'Placa de Vídeo Exemplo RTX 5070 Ti GamingPro-S 16GB',
    total_count: 14,
    sources: [
      { id: 1, name: 'Loja Demo Eletrônicos' },
      { id: 2, name: 'Loja Demo Informática' },
    ],
    first_seen_at: '2026-06-24T12:00:00Z',
    current_price_cents: 574_900,
    current_price_at: '2026-09-20T12:00:00Z',
    lowest_90d_cents: 574_900,
    average_30d_cents: 651_200,
    highest_90d_cents: 729_900,
    range: '90d',
    series: [
      { date: '2026-06-24', price_cents: 700_000 },
      { date: '2026-08-01', price_cents: 690_000 },
      { date: '2026-09-20', price_cents: 574_900 },
    ],
    postings: [
      {
        id: 1,
        source_id: 1,
        source_name: 'Loja Demo Eletrônicos',
        price_cents: 574_900,
        matched_at: '2026-09-20T12:00:00Z',
        message_link: 'https://t.me/c/demo/1',
      },
      {
        id: 2,
        source_id: 2,
        source_name: 'Loja Demo Informática',
        price_cents: 729_900,
        matched_at: '2026-06-24T12:00:00Z',
        message_link: null,
      },
    ],
    ...overrides,
  }
}

function buildEditableMatch(overrides: Partial<EditableMatch> = {}): EditableMatch {
  return {
    id: 1,
    source_id: 1,
    rule_id: 1,
    message_text: 'Placa de Vídeo Exemplo RTX 5070 Ti GamingPro-S 16GB por R$ 6.991,00',
    price_cents: 699_100,
    price_cash_cents: null,
    price_card_cents: null,
    message_link: 'https://t.me/c/demo/1',
    matched_at: '2026-09-20T12:00:00Z',
    created_at: '2026-09-20T12:00:00Z',
    deliveries: [],
    is_lowest_price_ever: false,
    grouped_source_ids: null,
    product_key: 'placa-video-exemplo-rtx',
    sparkline: [],
    snoozed: false,
    target_price_cents: null,
    target_hit: false,
    target_gap_pct: null,
    display_name: null,
    model_variant: null,
    price_source: null,
    original_price_cents: null,
    last_correction: null,
    ...overrides,
  }
}

describe('ProductPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows "Carregando…" while the request is in flight', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    render(<ProductPanel productKey="placa-video-exemplo-rtx" phase="open" onClose={() => {}} />)

    expect(screen.getByText('Carregando…')).toBeInTheDocument()
  })

  it('renders the product data: title, meta line, current price and stat tiles (BRL format)', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)

    expect(await screen.findByRole('heading', { name: product.title })).toBeInTheDocument()
    // 14 registros desde 24/06 (America/Sao_Paulo local day for the UTC instant) · 2 fontes.
    expect(screen.getByText(/14 registros desde 24\/06 · 2 fontes/)).toBeInTheDocument()
    expect(screen.getByText('Preço atual').parentElement).toHaveTextContent('R$ 5.749,00')
    expect(screen.getByText('Menor 90d').closest('.product-panel__stat')).toHaveTextContent('R$ 5.749,00')
    expect(screen.getByText('Média 30d').closest('.product-panel__stat')).toHaveTextContent('R$ 6.512,00')
    expect(screen.getByText('Maior 90d').closest('.product-panel__stat')).toHaveTextContent('R$ 7.299,00')
  })

  it('shows the price history chart with the local day-of-window axis labels', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)

    expect(await screen.findByRole('img', { name: 'Histórico de preço, 90d' })).toBeInTheDocument()
    expect(screen.getByText('24/06')).toBeInTheDocument()
    expect(screen.getByText('hoje')).toBeInTheDocument()
  })

  it('switches the range tab and refetches with the new range (90d/30d/7d)', async () => {
    const product = buildProduct()
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ ...product, range: String(input).includes('range=30d') ? '30d' : '90d' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await screen.findByRole('img', { name: 'Histórico de preço, 90d' })

    const tab30d = screen.getByRole('tab', { name: '30d' })
    expect(tab30d).toHaveAttribute('aria-selected', 'false')
    await user.click(tab30d)

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`/products/${product.product_key}?range=30d`))).toBe(
        true,
      ),
    )
    await screen.findByRole('img', { name: 'Histórico de preço, 30d' })
    expect(screen.getByRole('tab', { name: '30d' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '90d' })).toHaveAttribute('aria-selected', 'false')
  })

  it('shows a friendly message on a 404 (product not found)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ detail: 'Product not found' }, 404))))

    render(<ProductPanel productKey="produto-inexistente" phase="open" onClose={() => {}} />)

    expect(await screen.findByText('Produto não encontrado — pode ter sido removido.')).toBeInTheDocument()
  })

  it('shows the API error message on any other failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ detail: 'Erro interno' }, 500))))

    render(<ProductPanel productKey="placa-video-exemplo-rtx" phase="open" onClose={() => {}} />)

    expect(await screen.findByText('Erro interno')).toBeInTheDocument()
  })

  it('reveals the postings list only after "Ver as N postagens" is clicked, with source/price/date/link', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    const toggle = await screen.findByRole('button', { name: 'Ver as 14 postagens' })
    expect(screen.queryByText('Loja Demo Eletrônicos')).not.toBeInTheDocument()

    await user.click(toggle)

    expect(screen.getByText('Loja Demo Eletrônicos')).toBeInTheDocument()
    expect(screen.getByText('Loja Demo Informática')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', 'https://t.me/c/demo/1')
    expect(screen.getByText('Sem link')).toBeInTheDocument()
  })

  it('calls onClose from the × button', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={onClose} />)
    await screen.findByRole('heading', { name: product.title })
    await user.click(screen.getByRole('button', { name: 'Fechar painel do produto' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on Escape', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={onClose} />)
    await screen.findByRole('heading', { name: product.title })
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hides optional target/rule/snooze blocks and keeps internal editing available', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await screen.findByRole('heading', { name: product.title })

    expect(screen.queryByText('Alvo de preço')).not.toBeInTheDocument()
    expect(screen.queryByText('Criar regra disso')).not.toBeInTheDocument()
    expect(screen.queryByText('Silenciar 7 dias')).not.toBeInTheDocument()
    expect(screen.getByText('Editar dados')).toBeInTheDocument()
  })

  it('shows those blocks once their handler is passed', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(
      <ProductPanel
        productKey={product.product_key}
        phase="open"
        onClose={() => {}}
        onSaveTarget={() => {}}
        onCreateRule={() => {}}
        onSnooze={() => {}}
        onEditData={() => {}}
      />,
    )
    await screen.findByRole('heading', { name: product.title })

    expect(screen.getByText('Alvo de preço')).toBeInTheDocument()
    expect(screen.getByText('Criar regra disso')).toBeInTheDocument()
    expect(screen.getByText('Silenciar 7 dias')).toBeInTheDocument()
    expect(screen.getByText('Editar dados')).toBeInTheDocument()
  })

  it('"Salvar alvo" parses the pt-BR thousands dot and calls onSaveTarget with cents', async () => {
    const product = buildProduct()
    const onSaveTarget = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))
    const user = userEvent.setup()

    render(
      <ProductPanel
        productKey={product.product_key}
        phase="open"
        onClose={() => {}}
        onSaveTarget={onSaveTarget}
        targetRuleName="Placa de vídeo RTX"
      />,
    )
    await screen.findByRole('heading', { name: product.title })

    expect(screen.getByText('Regra: Placa de vídeo RTX')).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Avise-me abaixo de' })
    await user.clear(input)
    await user.type(input, '5.749')
    await user.click(screen.getByRole('button', { name: 'Salvar alvo' }))

    expect(onSaveTarget).toHaveBeenCalledWith(574_900)
  })

  it('prefills "Avise-me abaixo de" from targetPriceCents and shows a pt-BR error without calling onSaveTarget on an invalid value', async () => {
    const product = buildProduct()
    const onSaveTarget = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))
    const user = userEvent.setup()

    render(
      <ProductPanel
        productKey={product.product_key}
        phase="open"
        onClose={() => {}}
        onSaveTarget={onSaveTarget}
        targetPriceCents={580_000}
      />,
    )
    const input = await screen.findByRole('textbox', { name: 'Avise-me abaixo de' })
    expect(input).toHaveValue('5.800,00')

    await user.clear(input)
    await user.type(input, 'abc')
    await user.click(screen.getByRole('button', { name: 'Salvar alvo' }))

    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent('Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00.')
    expect(onSaveTarget).not.toHaveBeenCalled()
  })

  it('shows "Reativar" instead of "Silenciar 7 dias" when snoozed is true', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(
      <ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} onSnooze={() => {}} snoozed />,
    )

    expect(await screen.findByRole('button', { name: 'Reativar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Silenciar 7 dias' })).not.toBeInTheDocument()
  })

  it('calls onEdited after a save and after a revert, with the resulting match', async () => {
    const product = buildProduct({ current_price_cents: 699_100 })
    const match = buildEditableMatch()
    const saved = buildEditableMatch({ price_cents: 574_900, price_source: 'manual' })
    const onEdited = vi.fn()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (init?.method === 'PATCH') return Promise.resolve(jsonResponse(saved))
      if (path.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
      return Promise.resolve(jsonResponse(product))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(
      <ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} onEdited={onEdited} />,
    )
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))
    const price = await screen.findByRole('textbox', { name: 'Preço' })
    await user.clear(price)
    await user.type(price, '5.749')
    await user.click(screen.getByRole('button', { name: 'Salvar correção' }))

    await waitFor(() => expect(onEdited).toHaveBeenCalledWith(saved))
  })

  it('opens its own editor, highlights the original candidates and notifies onEditData when provided', async () => {
    const product = buildProduct()
    const match = buildEditableMatch()
    const onEditData = vi.fn()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      return Promise.resolve(jsonResponse(path.startsWith('/matches') ? [match] : product))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(
      <ProductPanel
        productKey={product.product_key}
        phase="open"
        onClose={() => {}}
        onEditData={onEditData}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))

    expect(onEditData).toHaveBeenCalledOnce()
    expect(await screen.findByRole('textbox', { name: 'Nome exibido' })).toHaveValue(product.title)
    expect(screen.getByRole('textbox', { name: 'Preço' })).toHaveValue('6.991,00')
    expect(screen.getByTestId('original-message').querySelectorAll('mark')).toHaveLength(2)
    expect(screen.getByRole('switch', { name: 'Aplicar o nome a todos os matches deste produto' })).toBeInTheDocument()
  })

  it('validates a short name and malformed price in the fields before saving', async () => {
    const product = buildProduct()
    const match = buildEditableMatch()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(jsonResponse(String(input).startsWith('/matches') ? [match] : product)),
      ),
    )
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))
    const name = await screen.findByRole('textbox', { name: 'Nome exibido' })
    const price = screen.getByRole('textbox', { name: 'Preço' })
    await user.clear(name)
    await user.type(name, 'ab')
    await user.tab()
    await user.clear(price)
    await user.type(price, '1,999')
    await user.tab()

    expect(screen.getByText('O nome deve ter entre 3 e 120 caracteres.')).toBeInTheDocument()
    expect(screen.getByText(/Preço inválido/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salvar correção' })).toBeDisabled()
  })

  it('saves a pt-BR thousands value and updates the read view', async () => {
    const product = buildProduct({ current_price_cents: 699_100 })
    const match = buildEditableMatch()
    const saved = buildEditableMatch({
      display_name: 'Placa Palit RTX 5070 Ti',
      price_cents: 574_900,
      price_source: 'manual',
      original_price_cents: 699_100,
      last_correction: { admin_id: 1, created_at: '2026-09-22T22:12:00Z' },
    })
    let wrote = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (init?.method === 'PATCH') {
        wrote = true
        return Promise.resolve(jsonResponse(saved))
      }
      if (path.startsWith('/matches')) return Promise.resolve(jsonResponse([match]))
      return Promise.resolve(jsonResponse(wrote ? { ...product, current_price_cents: 574_900 } : product))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))
    const name = await screen.findByRole('textbox', { name: 'Nome exibido' })
    const price = screen.getByRole('textbox', { name: 'Preço' })
    await user.clear(name)
    await user.type(name, saved.display_name ?? '')
    await user.clear(price)
    await user.type(price, '5.749')
    await user.click(screen.getByRole('switch', { name: /Aplicar o nome/ }))
    await user.click(screen.getByRole('button', { name: 'Salvar correção' }))

    await waitFor(() => expect(screen.getByText('Preço atual').parentElement).toHaveTextContent('R$ 5.749,00'))
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      display_name: 'Placa Palit RTX 5070 Ti',
      price: '5749,00',
      apply_name_to_product: true,
    })
  })

  it('places a 422 server detail on the corresponding field', async () => {
    const product = buildProduct()
    const match = buildEditableMatch()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return Promise.resolve(jsonResponse({ detail: 'O nome já não pode ser usado.' }, 422))
        }
        return Promise.resolve(jsonResponse(String(input).startsWith('/matches') ? [match] : product))
      }),
    )
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))
    await screen.findByRole('textbox', { name: 'Nome exibido' })
    await user.click(screen.getByRole('button', { name: 'Salvar correção' }))

    expect(await screen.findByText('O nome já não pode ser usado.')).toHaveAttribute('id', 'product-name-error')
  })

  it('shows the last correction and restores the detected value', async () => {
    const product = buildProduct({ current_price_cents: 574_900 })
    const edited = buildEditableMatch({
      display_name: 'Nome manual',
      price_cents: 574_900,
      price_source: 'manual',
      original_price_cents: 699_100,
      last_correction: { admin_id: 1, created_at: '2026-09-22T22:12:00Z' },
    })
    const reverted = buildEditableMatch({
      price_cents: 699_100,
      price_source: 'parsed',
      original_price_cents: 699_100,
      last_correction: { admin_id: 1, created_at: '2026-09-22T22:13:00Z' },
    })
    let revertedOnServer = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        revertedOnServer = true
        return Promise.resolve(jsonResponse(reverted))
      }
      if (String(input).startsWith('/matches')) return Promise.resolve(jsonResponse([edited]))
      return Promise.resolve(
        jsonResponse(revertedOnServer ? { ...product, current_price_cents: 699_100 } : product),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Editar dados' }))
    expect(await screen.findByText(/Última correção:/)).toHaveTextContent('R$ 6.991,00')
    await user.click(screen.getByRole('button', { name: 'Reverter ao detectado' }))

    await waitFor(() => expect(screen.getByText('Preço atual').parentElement).toHaveTextContent('R$ 6.991,00'))
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/matches/1/revert') && init?.method === 'POST')).toBe(true)
  })
})
