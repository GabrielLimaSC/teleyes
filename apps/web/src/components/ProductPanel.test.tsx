import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductPanel } from './ProductPanel'
import type { Product } from '../api/types'

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

  it('hides the target/rule/snooze/edit blocks when their handlers are not passed', async () => {
    const product = buildProduct()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(product))))

    render(<ProductPanel productKey={product.product_key} phase="open" onClose={() => {}} />)
    await screen.findByRole('heading', { name: product.title })

    expect(screen.queryByText('Alvo de preço')).not.toBeInTheDocument()
    expect(screen.queryByText('Criar regra disso')).not.toBeInTheDocument()
    expect(screen.queryByText('Silenciar 7 dias')).not.toBeInTheDocument()
    expect(screen.queryByText('Editar dados')).not.toBeInTheDocument()
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
})
