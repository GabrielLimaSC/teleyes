import { describe, expect, it } from 'vitest'
import { robustLowestPriceCents } from './robustLowestPrice'

describe('robustLowestPriceCents', () => {
  it('is null with no priced match', () => {
    expect(robustLowestPriceCents([])).toBeNull()
  })

  it('a rule with a single price just returns it (its own median)', () => {
    expect(robustLowestPriceCents([{ ruleId: 1, priceCents: 5_036_00 }])).toBe(5_036_00)
  })

  it('ignores a price below 20% of its own rule\'s median (a parsing outlier)', () => {
    // Median of [100, 459, 478, 680] = 568.5 → floor at 20% = 113.70. The
    // 100-cent "R$ 1,00" outlier is excluded; the real lowest (459) wins.
    const prices = [
      { ruleId: 1, priceCents: 100 },
      { ruleId: 1, priceCents: 459_00 },
      { ruleId: 1, priceCents: 478_00 },
      { ruleId: 1, priceCents: 680_00 },
    ]
    expect(robustLowestPriceCents(prices)).toBe(459_00)
  })

  it('with no outlier, just takes the real minimum', () => {
    const prices = [
      { ruleId: 1, priceCents: 478_00 },
      { ruleId: 2, priceCents: 680_00 },
      { ruleId: 2, priceCents: 675_00 },
    ]
    expect(robustLowestPriceCents(prices)).toBe(478_00)
  })

  it('the 20% floor is computed per rule, never mixed across rules', () => {
    // Rule 2's own prices are nowhere near rule 1's — a price that would
    // look like an outlier against rule 1's median is a perfectly normal
    // price for rule 2, and must never be dropped because of it.
    const prices = [
      { ruleId: 1, priceCents: 5_000_00 },
      { ruleId: 1, priceCents: 5_100_00 },
      { ruleId: 2, priceCents: 200_00 },
      { ruleId: 2, priceCents: 210_00 },
    ]
    expect(robustLowestPriceCents(prices)).toBe(200_00)
  })
})
