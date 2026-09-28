import { describe, expect, it } from 'vitest'
import { latestMatchForProduct } from './productMatch'
import type { Match } from '../api/types'

function buildMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 1,
    source_id: 1,
    rule_id: 1,
    message_text: 'exemplo',
    price_cents: 1000,
    price_cash_cents: null,
    price_card_cents: null,
    message_link: null,
    matched_at: '2026-09-20T12:00:00Z',
    created_at: '2026-09-20T12:00:00Z',
    deliveries: [],
    is_lowest_price_ever: false,
    grouped_source_ids: null,
    product_key: 'produto-exemplo',
    sparkline: [],
    snoozed: false,
    target_price_cents: null,
    target_hit: false,
    target_gap_pct: null,
    ...overrides,
  }
}

describe('latestMatchForProduct', () => {
  it('returns null when the product has no match', () => {
    expect(latestMatchForProduct([], 'produto-exemplo')).toBeNull()
    expect(latestMatchForProduct([buildMatch({ product_key: 'outro' })], 'produto-exemplo')).toBeNull()
  })

  it('picks the most recently matched_at match among the product\'s own matches', () => {
    const older = buildMatch({ id: 1, rule_id: 10, matched_at: '2026-09-18T10:00:00Z' })
    const newer = buildMatch({ id: 2, rule_id: 20, matched_at: '2026-09-20T10:00:00Z' })
    const otherProduct = buildMatch({ id: 3, rule_id: 30, product_key: 'outro', matched_at: '2026-09-21T10:00:00Z' })

    expect(latestMatchForProduct([older, newer, otherProduct], 'produto-exemplo')).toBe(newer)
  })

  it('ignores matches from a different product entirely', () => {
    const mine = buildMatch({ id: 1, product_key: 'produto-exemplo' })
    const other = buildMatch({ id: 2, product_key: 'produto-outro', matched_at: '2026-09-25T10:00:00Z' })

    expect(latestMatchForProduct([mine, other], 'produto-exemplo')).toBe(mine)
  })
})
