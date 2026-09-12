import { describe, expect, it } from 'vitest'
import { buildMatchQuery } from './matches'

describe('buildMatchQuery', () => {
  it('is empty for no filters', () => {
    expect(buildMatchQuery({})).toBe('')
  })

  it('maps every filter to the real /matches query param names', () => {
    const query = buildMatchQuery({
      ruleId: 1,
      sourceId: 2,
      recipientId: 3,
      minPriceCents: 100,
      maxPriceCents: 500,
      deliveryStatus: 'sent',
    })
    const params = new URLSearchParams(query)

    expect(params.get('rule_id')).toBe('1')
    expect(params.get('source_id')).toBe('2')
    expect(params.get('recipient_id')).toBe('3')
    expect(params.get('min_price_cents')).toBe('100')
    expect(params.get('max_price_cents')).toBe('500')
    expect(params.get('delivery_status')).toBe('sent')
  })

  it('omits params that were not provided', () => {
    const params = new URLSearchParams(buildMatchQuery({ ruleId: 1 }))
    expect([...params.keys()]).toEqual(['rule_id'])
  })
})
