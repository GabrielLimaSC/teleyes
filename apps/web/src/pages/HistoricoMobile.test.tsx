import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { activeFilterChips, MobileHistoricoItem } from './HistoricoMobile'
import type { MobileRow } from './HistoricoMobile'

const ROW: MobileRow = {
  id: 7,
  title: 'Placa RTX 5090',
  productKey: 'rtx',
  priceText: 'R$ 16.299,00',
  priceDetails: ['À vista · Cartão R$ 17.797,00'],
  ruleName: 'RTX',
  sourceName: 'Grupo Demo',
  time: 'Hoje, 06:47',
  link: 'https://t.me/c/1/2',
  deliveries: [{ status: 'failed', recipient_id: 1 } as never],
  deliveryLabel: 'Falha no envio',
  recipientNames: ['Alex'],
}

describe('MobileHistoricoItem', () => {
  it('shows delivery with reason, link and opens the product', async () => {
    const onOpen = vi.fn()
    render(<MobileHistoricoItem row={ROW} onOpenProduct={onOpen} onRequestDelete={vi.fn()} />)
    expect(screen.getByText('não enviado')).toBeInTheDocument()
    expect(screen.getByText('Falha no envio')).toBeInTheDocument()
    expect(screen.getByLabelText(/Abrir promoção/)).toHaveAttribute('href', 'https://t.me/c/1/2')
    await userEvent.click(screen.getByRole('button', { name: 'Placa RTX 5090' }))
    expect(onOpen).toHaveBeenCalledWith('rtx', expect.any(HTMLElement))
  })
})

describe('activeFilterChips', () => {
  it('lists only active filters', () => {
    const form = {
      search: 'x',
      ruleId: '1',
      sourceId: '',
      recipientId: '',
      minPriceReais: '',
      maxPriceReais: '200',
      deliveryStatus: 'sent',
      sort: '' as const,
    }
    const chips = activeFilterChips(form, [{ id: 1, name: 'RTX' } as never], [], [])
    expect(chips.map((c) => c.key)).toEqual(['ruleId', 'deliveryStatus', 'maxPriceReais'])
  })
})
