import { describe, expect, it } from 'vitest'
import { reportItem, savingsNoData, savingsOk } from './fixtures'
import { priceRange } from './priceRange'

// Range R$ 1.000 - R$ 2.000, median R$ 1.500.
const withPaid = (paidCents: number) =>
  reportItem({
    price_cents: paidCents,
    savings: savingsOk({ lowest_seen_cents: 100_000, highest_seen_cents: 200_000, median_90d_cents: 150_000 }),
  })

describe('priceRange (S21-04)', () => {
  it('puts a price below the median on the left half, in green', () => {
    const range = priceRange(withPaid(120_000))
    expect(range).toMatchObject({ status: 'ok', tone: 'good', outside: null, medianPos: 50 })
    expect(range.status === 'ok' && range.paidPos).toBeCloseTo(20)
  })

  it('puts a price above the median on the right half, in red', () => {
    const range = priceRange(withPaid(190_000))
    expect(range).toMatchObject({ status: 'ok', tone: 'bad', outside: null })
    expect(range.status === 'ok' && range.paidPos).toBeCloseTo(90)
  })

  it('pins a price outside the seen range to the edge, keeping the real tone', () => {
    expect(priceRange(withPaid(80_000))).toMatchObject({ paidPos: 0, outside: 'low', tone: 'good' })
    expect(priceRange(withPaid(260_000))).toMatchObject({ paidPos: 100, outside: 'high', tone: 'bad' })
  })

  it('is "no_history" without enough prices, or when the report has no figures', () => {
    expect(priceRange(reportItem({ savings: savingsNoData() }))).toEqual({ status: 'no_history' })
    expect(priceRange(reportItem({ savings: null, linked: false }))).toEqual({ status: 'no_history' })
  })

  it('does not divide by zero when every seen price is the same', () => {
    const item = reportItem({
      price_cents: 150_000,
      savings: savingsOk({ lowest_seen_cents: 150_000, highest_seen_cents: 150_000, median_90d_cents: 150_000 }),
    })
    expect(priceRange(item)).toMatchObject({ medianPos: 50, paidPos: 50 })
  })
})
