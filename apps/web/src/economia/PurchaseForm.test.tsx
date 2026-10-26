import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PurchaseForm } from './PurchaseForm'
import { EMPTY_DRAFT, valuesFromDraft } from './purchaseDraft'
import type { LinkOption } from './purchaseDraft'

function setup(overrides: Partial<Parameters<typeof PurchaseForm>[0]> = {}) {
  const onSubmit = vi.fn()
  const onSearch = vi.fn<(query: string) => Promise<LinkOption[]>>().mockResolvedValue([])
  render(
    <PurchaseForm
      title="Registrar compra"
      initial={valuesFromDraft(EMPTY_DRAFT, '2026-10-20')}
      submitting={false}
      error={null}
      onSearch={onSearch}
      onSubmit={onSubmit}
      onCancel={() => {}}
      {...overrides}
    />,
  )
  return { onSubmit, onSearch }
}

describe('PurchaseForm', () => {
  it('submits cents, an ISO instant and null for the optional fields', async () => {
    const { onSubmit } = setup()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Peça ou categoria'), 'Placa-mãe B850M')
    await user.type(screen.getByLabelText('Preço pago (R$)'), '1.199,90')
    await user.click(screen.getByRole('button', { name: 'Salvar compra' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const input = onSubmit.mock.calls[0]![0]
    expect(input).toMatchObject({
      name: 'Placa-mãe B850M',
      price_cents: 119_990,
      store: null,
      product_key: null,
      rule_id: null,
    })
    expect(input.purchased_at).toMatch(/^2026-10-20T\d{2}:00:00\.000Z$/)
  })

  it('rejects a blank name and an invalid price without calling the API', async () => {
    const { onSubmit } = setup()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Peça ou categoria'), '   ')
    await user.type(screen.getByLabelText('Preço pago (R$)'), '12')
    fireEvent.submit(screen.getByRole('form', { name: 'Registrar compra' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o nome')

    await user.clear(screen.getByLabelText('Peça ou categoria'))
    await user.type(screen.getByLabelText('Peça ou categoria'), 'Cabo')
    await user.clear(screen.getByLabelText('Preço pago (R$)'))
    await user.type(screen.getByLabelText('Preço pago (R$)'), 'abc')
    fireEvent.submit(screen.getByRole('form', { name: 'Registrar compra' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Preço inválido')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('pre-fills from a card: name, price and the link', () => {
    setup({
      initial: valuesFromDraft(
        { name: 'Placa RTX', priceCents: 549_900, productKey: 'rtx-5070', ruleId: 4, linkLabel: 'Placa RTX' },
        '2026-10-20',
      ),
    })

    expect(screen.getByLabelText('Peça ou categoria')).toHaveValue('Placa RTX')
    expect(screen.getByLabelText('Preço pago (R$)')).toHaveValue('5.499,00')
    expect(screen.getByText(/Vinculada a:/)).toHaveTextContent('Placa RTX')
  })

  it('links a product found by search, and sends its key without message content', async () => {
    const onSearch = vi
      .fn<(query: string) => Promise<LinkOption[]>>()
      .mockResolvedValue([{ kind: 'product', productKey: 'b850m-gigabyte', ruleId: null, label: 'Placa-mãe Gigabyte B850M' }])
    const { onSubmit } = setup({ onSearch })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Vincular a um produto ou regra (opcional)'), 'b850')
    await user.click(await screen.findByRole('option', { name: /Placa-mãe Gigabyte B850M/ }))

    expect(onSearch).toHaveBeenCalledWith('b850')
    expect(screen.getByLabelText('Peça ou categoria')).toHaveValue('Placa-mãe Gigabyte B850M')
    await user.type(screen.getByLabelText('Preço pago (R$)'), '1100')
    await user.click(screen.getByRole('button', { name: 'Salvar compra' }))

    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ product_key: 'b850m-gigabyte', rule_id: null, price_cents: 110_000 })
  })

  it('removes the link', async () => {
    setup({
      initial: valuesFromDraft(
        { name: 'X', priceCents: 1000, productKey: 'x', ruleId: null, linkLabel: 'X' },
        '2026-10-20',
      ),
    })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remover vínculo' }))

    await waitFor(() => expect(screen.getByLabelText('Vincular a um produto ou regra (opcional)')).toBeInTheDocument())
  })

  it('shows the error from the API', () => {
    setup({ error: 'a data da compra não pode estar no futuro' })

    expect(screen.getByRole('alert')).toHaveTextContent('futuro')
  })
})
