import { describe, expect, it } from 'vitest'
import fixturesJson from './fixtures.json'
import { DEMO_READONLY_DETAIL, createMockApi, shiftTimestamps } from './mockApi'
import type { DemoFixtures } from './mockApi'

const fixtures = fixturesJson as unknown as DemoFixtures
const REFERENCE = Date.parse(fixtures.reference_now)
const MINUTE = 60_000

interface MatchRow {
  id: number
  rule_id: number
  source_id: number
  price_cents: number | null
  matched_at: string
  product_key: string | null
  message_text: string
  deliveries: { recipient_id: number; status: string }[]
}

function api(loadedAt = new Date(REFERENCE + 90 * 24 * 3_600_000)) {
  return createMockApi(fixtures, loadedAt)
}

const getMatches = (query = ''): MatchRow[] =>
  api().handle('GET', `/matches${query}`).body as MatchRow[]

describe('shiftTimestamps', () => {
  it('moves instants and date-only buckets, leaving other strings alone', () => {
    const shifted = shiftTimestamps(
      { at: '2026-06-01T15:00:00Z', day: '2026-06-01', text: 'R$ 10,00', nested: [{ at: '2026-06-01T14:00:00Z' }] },
      2 * 86_400_000 + 60_000,
    )
    expect(shifted).toEqual({
      at: '2026-06-03T15:01:00Z',
      day: '2026-06-03',
      text: 'R$ 10,00',
      nested: [{ at: '2026-06-03T14:01:00Z' }],
    })
  })
})

describe('createMockApi', () => {
  it('answers the signed-in session with a fictional admin and token', () => {
    expect(api().handle('GET', '/auth/me')).toEqual({
      status: 200,
      body: { admin_id: 1, csrf_token: 'demo-csrf-token' },
    })
  })

  it('serves the main routes from the fixtures', () => {
    for (const path of ['/health', '/rules', '/sources', '/recipients', '/metrics', '/snoozes', '/digest', '/settings/feed', '/listener/status']) {
      expect(api().handle('GET', path).status, path).toBe(200)
    }
    expect(api().handle('GET', '/health').body).toMatchObject({ demo: true })
    expect(api().handle('GET', '/rules?include_inactive=true').status).toBe(200)
  })

  it('serves the fictional purchases and savings report, and still refuses to write them (S19-04)', () => {
    const purchases = api().handle('GET', '/purchases')
    expect(purchases.status).toBe(200)
    expect((purchases.body as unknown[]).length).toBeGreaterThanOrEqual(4)

    const report = api().handle('GET', '/savings/report?black_friday=2026-11-27')
    expect(report.status).toBe(200)
    expect(report.body).toMatchObject({ totals: { purchases: expect.any(Number) } })

    expect(api().handle('POST', '/purchases').status).toBe(403)
    expect(api().handle('DELETE', '/purchases/1').status).toBe(403)
  })

  it('rewrites dates relative to the load time: the newest offer is always recent', () => {
    for (const offsetDays of [0, 90, 400]) {
      const loadedAt = new Date(REFERENCE + offsetDays * 86_400_000)
      const matches = createMockApi(fixtures, loadedAt).handle('GET', '/matches').body as MatchRow[]
      const newest = Math.max(...matches.map((match) => Date.parse(match.matched_at)))
      const age = loadedAt.getTime() - newest
      expect(age).toBeGreaterThan(0)
      expect(age).toBeLessThan(24 * 60 * MINUTE)
    }
  })

  it('computes the digest schedule from the visitor clock', () => {
    const now = new Date(2030, 0, 15, 10, 0, 0)
    const body = api().handle('GET', '/digest', now).body as { next_run_at_local: string; send_at_local: string }
    expect(body.send_at_local).toBe('09:00')
    expect(body.next_run_at_local).toBe('2030-01-16 09:00')
  })

  it('refuses every write with the demo message', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(api().handle(method, '/rules/1')).toEqual({
        status: 403,
        body: { detail: DEMO_READONLY_DETAIL },
      })
    }
    expect(api().handle('POST', '/auth/login').status).toBe(403)
  })

  it('serves each product per range and falls back to 90d for an unknown range', () => {
    const key = getMatches().find((match) => match.product_key)!.product_key!
    const encoded = encodeURIComponent(key)
    for (const range of ['7d', '30d', '90d']) {
      const response = api().handle('GET', `/products/${encoded}?range=${range}`)
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ product_key: key, range })
    }
    expect(api().handle('GET', `/products/${encoded}?range=1y`).body).toMatchObject({ range: '90d' })
    expect(api().handle('GET', `/products/${encoded}/rule-suggestion`).status).toBe(200)
    expect(api().handle('GET', '/products/nao-existe?range=90d')).toEqual({
      status: 404,
      body: { detail: 'Product not found' },
    })
  })

  it('falls back to the route without query when the query is unknown', () => {
    expect(api().handle('GET', '/sources?whatever=1').body).toEqual(api().handle('GET', '/sources').body)
  })

  it('filters /matches on the client: rule, price range, search and sort', () => {
    const all = getMatches()
    const ruleId = all[0].rule_id
    expect(getMatches(`?rule_id=${ruleId}`).every((match) => match.rule_id === ruleId)).toBe(true)
    expect(getMatches(`?rule_id=${ruleId}`).length).toBeLessThan(all.length)

    const ranged = getMatches('?min_price_cents=100000&max_price_cents=200000')
    expect(ranged.length).toBeGreaterThan(0)
    expect(ranged.every((match) => match.price_cents! >= 100000 && match.price_cents! <= 200000)).toBe(true)

    const searched = getMatches('?q=NOTEBOOK')
    expect(searched.length).toBeGreaterThan(0)
    expect(searched.every((match) => /notebook/i.test(match.message_text))).toBe(true)

    const ascending = getMatches('?sort=price_asc').map((match) => match.price_cents!)
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b))
    const descending = getMatches('?sort=price_desc').map((match) => match.price_cents!)
    expect(descending).toEqual([...descending].sort((a, b) => b - a))

    expect(getMatches('?delivery_status=sent').every((match) => match.deliveries.some((d) => d.status === 'sent'))).toBe(true)
    expect(getMatches('?q=xyzxyz-sem-resultado')).toEqual([])
  })

  it('adds a fresh fictional match to /matches when the live stream emits one', () => {
    const mock = api()
    const before = (mock.handle('GET', '/matches').body as MatchRow[]).length
    const live = mock.nextLiveMatch()
    const after = mock.handle('GET', '/matches').body as MatchRow[]
    expect(after).toHaveLength(before + 1)
    expect(after[0].id).toBe(live.id)
    expect(after[0].message_text).toContain('example.com')
  })
})

describe('fixtures privacy', () => {
  it('only carries demo chat ids and example.com offer links', () => {
    const text = JSON.stringify(fixtures)
    expect(text).not.toMatch(/-100\d{6,}/)
    expect(text).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{30,}/)
    const chatIds = [...text.matchAll(/"telegram_chat_id":"([^"]*)"/g)].map((m) => m[1])
    expect(chatIds.length).toBeGreaterThan(0)
    for (const id of chatIds) expect(id.startsWith('demo:')).toBe(true)
    const hosts = new Set([...text.matchAll(/https?:\/\/([^/"\s]+)/g)].map((m) => m[1]))
    expect([...hosts]).toEqual(['example.com'])
  })
})
