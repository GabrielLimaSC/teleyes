import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Purchase } from '../api/purchases'
import { reportItem, savingsNoData, savingsReport } from '../economia/fixtures'
import { ECONOMIA_PATH } from '../economia/purchaseDraft'
import type { EconomiaNavState } from '../economia/purchaseDraft'
import { EconomiaPage } from './EconomiaPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

const purchase = (id: number, name: string): Purchase => ({
  id,
  name,
  price_cents: 120_000,
  purchased_at: '2026-10-20T15:00:00Z',
  store: null,
  product_key: id === 1 ? 'b850m' : null,
  rule_id: null,
  created_at: '2026-10-20T15:00:00Z',
})

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stub(report = savingsReport()) {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      if (method === 'DELETE') return Promise.resolve(json(null, 204))
      if (url.startsWith('/purchases')) {
        return Promise.resolve(json(report.items.map((item) => purchase(item.id, item.name))))
      }
      if (url.startsWith('/savings/report')) return Promise.resolve(json(report))
      if (url.startsWith('/rules')) return Promise.resolve(json([]))
      if (url.startsWith('/matches')) return Promise.resolve(json([]))
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return calls
}

function renderPage(state?: EconomiaNavState) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: ECONOMIA_PATH, state }]}>
      <EconomiaPage />
    </MemoryRouter>,
  )
}

describe('EconomiaPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the purchases with totals, the Black Friday count and the methodology', async () => {
    stub()
    renderPage()

    expect(await screen.findByText('Placa-mãe B850M')).toBeInTheDocument()
    const tiles = screen.getByRole('region', { name: 'Resumo' })
    expect(within(tiles).getByText('R$ 3.000,00')).toBeInTheDocument()
    expect(within(tiles).getByText('+R$ 250,00')).toBeInTheDocument()
    expect(within(tiles).getByText('38–52 dias antes')).toBeInTheDocument()
    expect(screen.getByText(/Estimativa baseada só nos preços que o próprio teleyes viu/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ruído evitado' })).toHaveTextContent('20.298')
  })

  it('shows paying above the median as a negative saving, "sem dados" and only the amount when unlinked', async () => {
    stub(
      savingsReport({
        items: [
          reportItem({ id: 1, name: 'Placa-mãe B850M' }),
          reportItem({
            id: 2,
            name: 'SSD NVMe',
            savings: { ...reportItem().savings!, saving_vs_median_cents: -10_000, saving_vs_median_pct: -20 },
          }),
          reportItem({ id: 3, name: 'Fone', savings: savingsNoData() }),
          reportItem({ id: 4, name: 'Cabo HDMI', linked: false, savings: null }),
        ],
      }),
    )
    renderPage()
    await screen.findByText('SSD NVMe')

    const rowOf = (name: string) => screen.getByText(name).closest('tr')!
    expect(rowOf('SSD NVMe')).toHaveTextContent('−R$ 100,00 (-20,0%)')
    expect(rowOf('SSD NVMe').querySelector('.economia-tone--bad')).not.toBeNull()
    expect(rowOf('Fone')).toHaveTextContent('sem dados')
    expect(rowOf('Cabo HDMI').querySelector('[data-label="Economia estimada"]')).toHaveTextContent('—')
  })

  it('says so when there is no purchase yet and keeps the card button off', async () => {
    stub(
      savingsReport({
        items: [],
        totals: {
          purchases: 0,
          linked_with_data: 0,
          total_paid_cents: 0,
          estimated_saving_cents: 0,
          reference_total_cents: 0,
          estimated_saving_pct: null,
        },
      }),
    )
    renderPage()

    expect(await screen.findByText(/Nenhuma compra registrada ainda/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gerar cartão de resultados' })).toBeDisabled()
  })

  it('opens the form pre-filled by "Marcar como comprado"', async () => {
    stub()
    renderPage({
      prefill: { name: 'Placa RTX 5070', priceCents: 549_900, productKey: 'rtx-5070', ruleId: 2, linkLabel: 'Placa RTX 5070' },
    })

    const form = await screen.findByRole('form', { name: 'Registrar compra' })
    expect(within(form).getByLabelText('Peça ou categoria')).toHaveValue('Placa RTX 5070')
    expect(within(form).getByLabelText('Preço pago (R$)')).toHaveValue('5.499,00')
  })

  it('registers a purchase with the CSRF token and reloads the report', async () => {
    const calls = stub()
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('Placa-mãe B850M')

    await user.click(screen.getByRole('button', { name: 'Registrar compra' }))
    const form = await screen.findByRole('form', { name: 'Registrar compra' })
    await user.type(within(form).getByLabelText('Peça ou categoria'), 'Fonte 750W')
    await user.type(within(form).getByLabelText('Preço pago (R$)'), '499')
    await user.click(within(form).getByRole('button', { name: 'Salvar compra' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/purchases')).toBe(true))
    const post = calls.find((call) => call.method === 'POST')!
    expect(JSON.parse(post.body!)).toMatchObject({ name: 'Fonte 750W', price_cents: 49_900 })
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Registrar compra' })).toBeNull())
  })

  it('asks for confirmation before deleting a purchase', async () => {
    const calls = stub()
    renderPage()
    const user = userEvent.setup()
    const row = (await screen.findByText('SSD NVMe 2 TB')).closest('tr')!

    await user.click(within(row).getByRole('button', { name: 'Excluir' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    await user.click(within(row).getByRole('button', { name: 'Excluir' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Excluir compra' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/purchases/2')).toBe(true))
  })

  it('opens the card panel with "incluir lojas" off by default', async () => {
    stub()
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('Placa-mãe B850M')

    await user.click(screen.getByRole('button', { name: 'Gerar cartão de resultados' }))

    expect(screen.getByRole('checkbox', { name: 'Mostrar peças' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Incluir lojas' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Baixar imagem (PNG)' })).toBeEnabled()
    const preview = screen.getByRole('img', { name: 'Prévia do cartão de resultados' })
    expect(decodeURIComponent(preview.getAttribute('src')!)).not.toContain('Loja Exemplo')

    await user.click(screen.getByRole('checkbox', { name: 'Mostrar peças' }))
    expect(screen.getByRole('checkbox', { name: 'Incluir lojas' })).toBeDisabled()
    expect(decodeURIComponent(screen.getByRole('img', { name: 'Prévia do cartão de resultados' }).getAttribute('src')!)).not.toContain(
      'Placa-mãe B850M',
    )
  })
})
