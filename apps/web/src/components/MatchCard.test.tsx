import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MatchCard } from './MatchCard'
import type { Match, Recipient, Rule, Source } from '../api/types'

const rule: Rule = {
  id: 1,
  name: 'iPhone até R$ 4.000',
  include_terms: 'iphone',
  exclude_terms: null,
  max_price_cents: 400_000,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

const source: Source = {
  id: 1,
  name: 'Urubu das Promoções',
  telegram_chat_id: '-1001',
  active: true,
  created_at: '2026-01-01T00:00:00Z',
}

const recipients: Recipient[] = [
  {
    id: 1,
    name: 'Gabriel',
    telegram_chat_id: '999',
    allowlisted: true,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function buildMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 1,
    source_id: 1,
    rule_id: 1,
    message_text: 'Promoção iPhone 15 128GB por R$ 3.899',
    price_cents: 389_900,
    message_link: null,
    matched_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    deliveries: [],
    ...overrides,
  }
}

describe('MatchCard', () => {
  it('renders product, price, source/rule metadata and status', () => {
    render(
      <MatchCard
        match={buildMatch({ deliveries: [{ id: 1, recipient_id: 1, status: 'sent', delivered_at: '2026-01-01T00:00:01Z', created_at: '2026-01-01T00:00:01Z' }] })}
        rule={rule}
        source={source}
        recipients={recipients}
      />,
    )

    expect(screen.getByText('Promoção iPhone 15 128GB por R$ 3.899')).toBeInTheDocument()
    expect(screen.getByText('R$ 3.899,00')).toBeInTheDocument()
    expect(screen.getByText(/Urubu das Promoções/)).toBeInTheDocument()
    expect(screen.getByText(/iPhone até R\$ 4\.000/)).toBeInTheDocument()
    expect(screen.getByText(/Gabriel/)).toBeInTheDocument()
    expect(screen.getByText('Entregue')).toBeInTheDocument()
  })

  it('falls back to raw ids when rule/source lookups are missing', () => {
    render(<MatchCard match={buildMatch()} rule={undefined} source={undefined} recipients={[]} />)

    expect(screen.getByText(/Fonte: #1/)).toBeInTheDocument()
    expect(screen.getByText(/Regra: #1/)).toBeInTheDocument()
  })

  it('shows a price placeholder when no price was extracted', () => {
    render(
      <MatchCard match={buildMatch({ price_cents: null })} rule={rule} source={source} recipients={[]} />,
    )

    expect(screen.getByText('Preço não identificado')).toBeInTheDocument()
  })

  it('has no Aurora Glow ring or label by default (no real price-history data yet)', () => {
    const { container } = render(
      <MatchCard match={buildMatch()} rule={rule} source={source} recipients={[]} />,
    )

    expect(container.querySelector('.match-card--aurora')).not.toBeInTheDocument()
    expect(screen.queryByText('Menor preço já visto')).not.toBeInTheDocument()
  })

  it('renders the Aurora Glow ring and label when isLowestPriceEver is true', () => {
    const { container } = render(
      <MatchCard
        match={buildMatch()}
        rule={rule}
        source={source}
        recipients={[]}
        isLowestPriceEver
      />,
    )

    expect(container.querySelector('.match-card--aurora')).toBeInTheDocument()
    expect(screen.getByText('Menor preço já visto')).toBeInTheDocument()
  })
})
