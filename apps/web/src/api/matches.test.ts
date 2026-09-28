import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMatchQuery, revertMatch, updateMatch } from './matches'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('manual match corrections', () => {
  it('PATCHes only the fields defined by the backend contract', async () => {
    const responseBody = { id: 42, display_name: 'RTX 5070 Ti' }
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      updateMatch('csrf-123', 42, {
        display_name: 'RTX 5070 Ti',
        price: '5.749',
        apply_name_to_product: true,
      }),
    ).resolves.toEqual(responseBody)

    expect(fetchMock).toHaveBeenCalledWith(
      '/matches/42',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'same-origin',
        body: JSON.stringify({
          display_name: 'RTX 5070 Ti',
          price: '5.749',
          apply_name_to_product: true,
        }),
      }),
    )
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-123')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('POSTs revert without inventing a request payload', async () => {
    const responseBody = { id: 42, price_source: 'parsed' }
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(revertMatch('csrf-123', 42)).resolves.toEqual(responseBody)

    expect(fetchMock).toHaveBeenCalledWith(
      '/matches/42/revert',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
  })
})
