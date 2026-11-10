import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { LatestOffers } from './LatestOffers'

const match = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, rule_id: 1, message_text: `Fone ${id}`, price_cents: 24990, matched_at: '2026-11-05T10:00:00Z', product_key: `fone-${id}`, target_hit: false, ...extra }) as never

describe('LatestOffers', () => {
  it('lists at most five, links to the product panel and marks target hits', () => {
    render(
      <MemoryRouter>
        <LatestOffers matches={[1, 2, 3, 4, 5, 6].map((id) => match(id, id === 1 ? { target_hit: true } : {}))} rules={[]} />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('link', { name: /Fone/ })).toHaveLength(5)
    expect(screen.getByText('alvo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver todas' })).toHaveAttribute('href', '/feed')
  })
})
