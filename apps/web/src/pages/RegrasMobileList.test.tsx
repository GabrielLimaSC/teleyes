import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Rule } from '../api/types'
import { RegrasMobileList } from './RegrasMobileList'

const rule: Rule = {
  id: 1,
  name: 'SSD NVMe',
  include_terms: 'ssd nvme',
  exclude_terms: null,
  max_price_cents: 90000,
  target_price_cents: 34900,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  lowest_price_cents: null,
  lowest_price_24h_cents: 30000,
  snoozed_until: null,
  history_30d: [],
  recipient_ids: [],
}

function setup(rules: Rule[], expandedId: number | null = null) {
  const props = {
    rules,
    recipients: [],
    listener: { status: null, error: null, requesting: false, onApply: vi.fn() },
    expandedId,
    onToggleExpand: vi.fn(),
    pausingId: null,
    onPause: vi.fn(),
    onResume: vi.fn(),
    menuItems: () => [],
    recent: { ruleId: 1, matches: [], failed: false },
    onEdit: vi.fn(),
    onTest: vi.fn(),
    onCreate: vi.fn(),
    onTemplate: vi.fn(),
  }
  render(
    <MemoryRouter>
      <RegrasMobileList {...props} />
    </MemoryRouter>,
  )
  return props
}

describe('RegrasMobileList', () => {
  it('shows the card and expands it', async () => {
    const props = setup([rule])
    expect(screen.getByText('atingido')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Ver gráfico e ofertas' }))
    expect(props.onToggleExpand).toHaveBeenCalledWith(1)
  })

  it('offers templates when empty', async () => {
    const props = setup([])
    await userEvent.click(screen.getByRole('button', { name: 'Placa de vídeo' }))
    expect(props.onTemplate).toHaveBeenCalledWith('gpu')
  })

  it('opened card shows Editar and Testar', async () => {
    const props = setup([rule], 1)
    await userEvent.click(screen.getByRole('button', { name: 'Testar' }))
    expect(props.onTest).toHaveBeenCalled()
    expect(screen.getByText('Nenhuma oferta ainda para esta regra.')).toBeInTheDocument()
  })
})
