import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalReport, Purchase } from '../api/purchases'
import { reportItem, savingsNoData, savingsReport } from '../economia/fixtures'
import { ECONOMIA_PATH } from '../economia/purchaseDraft'
import type { EconomiaNavState } from '../economia/purchaseDraft'
import { EconomiaPage } from './EconomiaPage'

vi.mock('../auth/AuthContext', () => ({
  CSRF_MISSING_MESSAGE: 'csrf ausente',
  useAuth: () => ({ csrfToken: 'test-csrf' }),
}))

const purchase = (id: number, name: string, reference?: { cents: number; note: string } | null): Purchase => ({
  id,
  name,
  price_cents: 120_000,
  purchased_at: '2026-10-20T15:00:00Z',
  store: null,
  product_key: id === 1 ? 'b850m' : null,
  rule_id: null,
  reference_price_cents: reference?.cents ?? null,
  reference_note: reference?.note ?? null,
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
      if (url === '/savings/goal' && method === 'PUT') return Promise.resolve(json({}))
      if (method === 'DELETE') return Promise.resolve(json(null, 204))
      if (url.startsWith('/purchases')) {
        return Promise.resolve(json(
            report.items.map((item) =>
              purchase(item.id, item.name, item.reference ? { cents: item.reference.price_cents, note: item.reference.note ?? '' } : null),
            ),
          ))
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

  it('lists the purchases with totals, the methodology and no Black Friday', async () => {
    stub()
    renderPage()

    expect(await screen.findByText('Placa-mãe B850M')).toBeInTheDocument()
    const tiles = screen.getByRole('region', { name: 'Resumo' })
    expect(within(tiles).getByText('R$ 3.000,00')).toBeInTheDocument()
    expect(within(tiles).getByText('+R$ 250,00')).toBeInTheDocument()
    expect(within(tiles).queryByText(/Black Friday/)).toBeNull()
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
          reportItem({ id: 4, name: 'Cabo HDMI', linked: false, link_kind: null, savings: null }),
        ],
      }),
    )
    renderPage()
    await screen.findByText('SSD NVMe')

    const rowOf = (name: string) => screen.getByText(name).closest('tr')!
    expect(rowOf('SSD NVMe')).toHaveTextContent('−R$ 100,00 · 20,0%')
    expect(rowOf('SSD NVMe').querySelector('.economia-pill--bad')).not.toBeNull()
    expect(rowOf('Fone')).toHaveTextContent('sem histórico')
    expect(rowOf('Fone').querySelector('.price-range--empty')).toHaveTextContent('menos de 3 preços vistos — fora da conta')
    // Unlinked: the pill is an action to link a rule, not a figure.
    expect(within(rowOf('Cabo HDMI')).getByRole('button', { name: 'Vincular regra' })).toBeInTheDocument()
    expect(rowOf('Cabo HDMI').querySelector('.economia-pill--good, .economia-pill--bad')).toBeNull()
  })

  it('"Vincular regra" opens the edit form with the link search focused', async () => {
    stub(savingsReport({ items: [reportItem({ id: 4, name: 'Cabo HDMI', linked: false, link_kind: null, savings: null })] }))
    renderPage()
    const user = userEvent.setup()
    const row = (await screen.findByText('Cabo HDMI')).closest('tr')!

    await user.click(within(row).getByRole('button', { name: 'Vincular regra' }))

    const form = await screen.findByRole('form', { name: 'Editar compra' })
    expect(within(form).getByRole('combobox')).toHaveFocus()
  })

  it('shows where the history comes from when the purchase is linked', async () => {
    stub(
      savingsReport({
        items: [
          reportItem({ id: 1, name: 'Placa', link_kind: 'rule', link_label: 'RTX 5070' }),
          reportItem({ id: 2, name: 'SSD', link_kind: 'rule', link_label: 'SSD', savings: savingsNoData() }),
        ],
      }),
    )
    renderPage()
    const row = (await screen.findByText('Placa')).closest('tr')!
    expect(row).toHaveTextContent('pela regra RTX 5070')
    // Linked but with fewer than 3 prices: still "sem histórico", with the same text as before.
    expect(screen.getByText('SSD', { selector: '.economia-table__name' }).closest('tr')).toHaveTextContent('sem histórico')
  })

  it('keeps the user reference separate and labelled, outside the teleyes saving', async () => {
    stub(
      savingsReport({
        totals: {
          purchases: 2,
          linked_with_data: 1,
          total_paid_cents: 160_000,
          estimated_saving_cents: 35_000,
          reference_total_cents: 155_000,
          estimated_saving_pct: 22.6,
          reference_saving_cents: 10_000,
          reference_purchases: 1,
        },
        items: [
          reportItem({ id: 1, name: 'Placa' }),
          reportItem({
            id: 2,
            name: 'SSD NVMe',
            price_cents: 40_000,
            linked: false,
            link_kind: null,
            savings: null,
            reference: { price_cents: 50_000, note: 'média do Google Shopping', saving_cents: 10_000, pct: 20 },
          }),
        ],
      }),
    )
    renderPage()
    const row = (await screen.findByText('SSD NVMe')).closest('tr')!

    expect(row).toHaveTextContent('Referência sua: R$ 500,00 (média do Google Shopping)')
    expect(row).toHaveTextContent('+R$ 100,00 · 20,0%')
    expect(row).toHaveTextContent('pela sua referência')
    expect(within(row).queryByRole('button', { name: 'Vincular regra' })).toBeNull()
    expect(row.querySelector('.economia-pill--good')).toBeNull()
    const tiles = screen.getByRole('region', { name: 'Resumo' })
    expect(within(tiles).getByText('+R$ 350,00')).toBeInTheDocument() // teleyes only
    expect(within(tiles).getByTestId('reference-saving')).toHaveTextContent(
      '+R$ 100,00 pelas suas referências (1 compra)',
    )
  })

  it('hides the reference line when there is no reference', async () => {
    stub()
    renderPage()
    await screen.findByText('Placa-mãe B850M')
    expect(screen.queryByTestId('reference-saving')).toBeNull()
  })

  it('shows the saving card with the percentage badge and keeps the methodology visible', async () => {
    stub()
    renderPage()
    await screen.findByText('Placa-mãe B850M')
    const tiles = screen.getByRole('region', { name: 'Resumo' })
    expect(within(tiles).getByText('7,7% abaixo da mediana')).toBeInTheDocument()
    expect(within(tiles).getByText('Mediana 90d')).toBeInTheDocument()
    expect(within(tiles).getByText('Você pagou')).toBeInTheDocument()
    expect(within(tiles).getByText(/numa única peça \(/)).toBeInTheDocument()
    expect(within(tiles).getByText(/Não é uma garantia de preço de mercado/)).toBeInTheDocument()
  })

  it('shows a negative total in red with the "acima da mediana" badge', async () => {
    stub(
      savingsReport({
        totals: {
          purchases: 1,
          linked_with_data: 1,
          total_paid_cents: 130_000,
          estimated_saving_cents: -30_000,
          reference_total_cents: 100_000,
          estimated_saving_pct: -30,
        },
        items: [reportItem({ price_cents: 130_000, savings: { ...reportItem().savings!, median_90d_cents: 100_000, saving_vs_median_cents: -30_000, saving_vs_median_pct: -30 } })],
      }),
    )
    renderPage()
    await screen.findByText('Placa-mãe B850M')
    const tiles = screen.getByRole('region', { name: 'Resumo' })
    expect(within(tiles).getByText('−R$ 300,00')).toHaveClass('economia-tone--bad')
    expect(within(tiles).getByText('30,0% acima da mediana')).toBeInTheDocument()
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

    expect(await screen.findByText('Nenhuma compra registrada')).toBeInTheDocument()
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

    await user.click(within(row).getByRole('button', { name: /Mais ações da compra SSD NVMe 2 TB/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    await user.click(within(row).getByRole('button', { name: /Mais ações da compra SSD NVMe 2 TB/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Excluir' }))
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

  describe('savings goal (S21-08)', () => {
    const goal = (overrides: Partial<GoalReport> = {}): GoalReport => ({
      amount_cents: 200_000,
      deadline: '2026-12-31',
      saved_cents: 143_000,
      pct: 71.5,
      remaining_cents: 57_000,
      days_left: 58,
      pace: 'on_track',
      ...overrides,
    })

    it('without a goal shows the empty state and hides the "Parte da meta" column', async () => {
      stub()
      renderPage()

      const tiles = await screen.findByRole('region', { name: 'Resumo' })
      expect(within(tiles).getByText('Meta de economia')).toBeInTheDocument()
      expect(within(tiles).getByRole('button', { name: 'Definir meta' })).toBeInTheDocument()
      expect(screen.queryByRole('columnheader', { name: 'Parte da meta' })).toBeNull()
    })

    it('with a positive goal shows progress, what is missing, the pace and each purchase share', async () => {
      const base = savingsReport()
      stub(
        savingsReport({
          goal: goal(),
          items: [reportItem({ share_of_goal: 8.3 }), { ...base.items[1]!, share_of_goal: -2 }, { ...base.items[2]!, share_of_goal: null }],
        }),
      )
      renderPage()

      const tiles = await screen.findByRole('region', { name: 'Resumo' })
      expect(within(tiles).getByText(/72% de R\$\s2\.000,00/)).toBeInTheDocument()
      expect(within(tiles).getByText(/Faltam R\$\s570,00 até 31\/12 · 58 dias/)).toBeInTheDocument()
      expect(within(tiles).getByText(/R\$\s1\.430,00 economizados/)).toBeInTheDocument()
      expect(within(tiles).getByText('ritmo: no prazo')).toBeInTheDocument()
      expect(within(tiles).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '72')
      expect(screen.getByRole('columnheader', { name: 'Parte da meta' })).toBeInTheDocument()
      expect(screen.getByText('+8,3%')).toBeInTheDocument()
      expect(screen.getByText('−2,0%')).toBeInTheDocument()
    })

    it('with a negative estimated saving keeps the bar empty and says so', async () => {
      stub(savingsReport({ goal: goal({ saved_cents: -10_000, pct: -5, remaining_cents: 210_000, pace: 'behind' }) }))
      renderPage()

      const tiles = await screen.findByRole('region', { name: 'Resumo' })
      expect(within(tiles).getByText(/0% de R\$\s2\.000,00/)).toBeInTheDocument()
      expect(within(tiles).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      expect(within(tiles).getByText(/Economia estimada negativa até agora/)).toBeInTheDocument()
      expect(within(tiles).getByText('ritmo: atrasado')).toBeInTheDocument()
    })

    it('edits the goal with the CSRF token and validates the deadline', async () => {
      const calls = stub(savingsReport({ goal: goal() }))
      renderPage()
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: 'editar' }))
      const dialog = await screen.findByRole('dialog')
      const amount = within(dialog).getByLabelText(/Quanto quer economizar/)
      await user.clear(amount)
      await user.type(amount, '2500')
      fireEvent.change(within(dialog).getByLabelText('Até quando'), { target: { value: '2020-01-01' } })
      await user.click(within(dialog).getByRole('button', { name: 'Salvar meta' }))
      expect(within(dialog).getByRole('alert')).toHaveTextContent('O prazo precisa estar no futuro.')
      expect(calls.some((call) => call.method === 'PUT')).toBe(false)

      fireEvent.change(within(dialog).getByLabelText('Até quando'), { target: { value: '2999-12-31' } })
      await user.click(within(dialog).getByRole('button', { name: 'Salvar meta' }))

      await waitFor(() => {
        const put = calls.find((call) => call.method === 'PUT' && call.url === '/savings/goal')
        expect(put?.body).toBe(JSON.stringify({ amount_cents: 250_000, deadline: '2999-12-31' }))
      })
    })

    it('removes the goal from the dialog', async () => {
      const calls = stub(savingsReport({ goal: goal() }))
      renderPage()
      const user = userEvent.setup()

      await user.click(await screen.findByRole('button', { name: 'editar' }))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remover meta' }))

      await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/savings/goal')).toBe(true))
    })
  })
})
