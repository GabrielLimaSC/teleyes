/**
 * S19-05: the API of the static public demo (GitHub Pages), answered from the
 * fixtures that `scripts/export_demo_fixtures.py` records from the real demo
 * backend. Pure and DOM-free so it is unit-testable; `install.ts` wires it to
 * `fetch` and `EventSource`. Only ever reachable from a `vite build --mode
 * demo-static` bundle (see `flag.ts`).
 */

export const DEMO_READONLY_DETAIL = 'Modo demonstração: alterações desativadas.'

export interface DemoFixtures {
  /** The instant the fixtures were recorded at; every timestamp is shifted by `now - reference_now`. */
  reference_now: string
  routes: Record<string, unknown>
}

export interface MockResponse {
  status: number
  body: unknown
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Row = Record<string, Json>

const DAY_MS = 86_400_000
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Rewrites every instant (and date-only bucket) in `value`, returning a copy. */
export function shiftTimestamps<T>(value: T, deltaMs: number): T {
  const deltaDays = Math.round(deltaMs / DAY_MS)
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (ISO_INSTANT.test(node)) {
        return new Date(Date.parse(node) + deltaMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
      }
      if (ISO_DATE.test(node)) {
        return new Date(Date.parse(`${node}T00:00:00Z`) + deltaDays * DAY_MS).toISOString().slice(0, 10)
      }
      return node
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]))
    }
    return node
  }
  return walk(value) as T
}

function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function sortedQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
}

/** `path?sorted-query`, with the path percent-decoded so Python's and JS's encoders agree. */
export function routeKey(pathname: string, params: URLSearchParams): string {
  const query = sortedQuery(params)
  return `${safeDecode(pathname)}${query ? `?${query}` : ''}`
}

function priceOf(match: Row): number | null {
  return typeof match.price_cents === 'number' ? match.price_cents : null
}

function filterMatches(matches: Row[], params: URLSearchParams): Row[] {
  const number = (name: string): number | null => {
    const raw = params.get(name)
    return raw === null || raw === '' || Number.isNaN(Number(raw)) ? null : Number(raw)
  }
  const ruleId = number('rule_id')
  const sourceId = number('source_id')
  const recipientId = number('recipient_id')
  const minPrice = number('min_price_cents')
  const maxPrice = number('max_price_cents')
  const status = params.get('delivery_status')
  const query = normalizeText(params.get('q') ?? '').trim()

  const kept = matches.filter((match) => {
    const deliveries = (match.deliveries ?? []) as Row[]
    if (ruleId !== null && match.rule_id !== ruleId) return false
    if (sourceId !== null && match.source_id !== sourceId) return false
    if (recipientId !== null && !deliveries.some((delivery) => delivery.recipient_id === recipientId)) return false
    if (minPrice !== null && !(typeof match.price_cents === 'number' && match.price_cents >= minPrice)) return false
    if (maxPrice !== null && !(typeof match.price_cents === 'number' && match.price_cents <= maxPrice)) return false
    if (status !== null && !deliveries.some((delivery) => delivery.status === status)) return false
    if (query !== '') {
      const haystack = normalizeText(
        [match.display_name, match.product_key, match.message_text].filter((v) => typeof v === 'string').join(' '),
      )
      if (!haystack.includes(query)) return false
    }
    return true
  })

  const sort = params.get('sort')
  if (sort !== 'price_asc' && sort !== 'price_desc') return kept
  const direction = sort === 'price_asc' ? 1 : -1
  // Offers without a price always sort last, like the API does.
  return [...kept].sort((a, b) => {
    const [left, right] = [priceOf(a), priceOf(b)]
    if (left === right) return 0
    if (left === null) return 1
    if (right === null) return -1
    return (left - right) * direction
  })
}

/** The next time the digest would go out, in the visitor's own clock. */
function digestSchedule(sendAtLocal: string, now: Date): { local: string; utc: string } {
  const [hours, minutes] = sendAtLocal.split(':').map(Number)
  const next = new Date(now)
  next.setHours(hours ?? 9, minutes ?? 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  const local = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())} ${pad(next.getHours())}:${pad(next.getMinutes())}`
  return { local, utc: next.toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

export interface MockApi {
  handle: (method: string, url: string, now?: Date) => MockResponse
  /** A new fictional offer "just posted", for the simulated live stream. */
  nextLiveMatch: () => Row
}

export function createMockApi(fixtures: DemoFixtures, loadedAt: Date = new Date()): MockApi {
  const deltaMs = loadedAt.getTime() - Date.parse(fixtures.reference_now)
  const routes = new Map<string, unknown>()
  for (const [key, body] of Object.entries(fixtures.routes)) {
    const [path, query = ''] = key.split('?')
    routes.set(routeKey(path, new URLSearchParams(query)), body)
  }
  const baseMatches = (routes.get('/matches') ?? []) as Row[]
  const liveMatches: Row[] = []
  let liveCounter = 0

  const lookup = (path: string, params: URLSearchParams): unknown => {
    if (routes.has(routeKey(path, params))) return routes.get(routeKey(path, params))
    // Unknown query: the same route without it (`/products/x?range=1y` -> 90d, `/rules?foo` -> `/rules`).
    if (path.startsWith('/products/') && params.has('range')) {
      const fallback = routeKey(path, new URLSearchParams({ range: '90d' }))
      if (routes.has(fallback)) return routes.get(fallback)
    }
    return routes.get(routeKey(path, new URLSearchParams()))
  }

  const read = (path: string, params: URLSearchParams, now: Date): MockResponse => {
    if (path === '/auth/me') return { status: 200, body: { admin_id: 1, csrf_token: 'demo-csrf-token' } }
    if (path === '/matches') {
      return { status: 200, body: filterMatches([...liveMatches, ...baseMatches], params) }
    }
    if (path === '/digest') {
      const digest = lookup(path, new URLSearchParams()) as Row | undefined
      if (digest === undefined) return { status: 404, body: { detail: 'Not Found' } }
      const next = digestSchedule(String(digest.send_at_local ?? '09:00'), now)
      return {
        status: 200,
        body: { ...digest, next_run_at_local: next.local, next_run_at_utc: next.utc },
      }
    }
    const body = lookup(path, params)
    if (body === undefined) {
      return {
        status: 404,
        body: { detail: path.startsWith('/products/') ? 'Product not found' : 'Not Found' },
      }
    }
    return { status: 200, body }
  }

  return {
    handle(method, url, now = new Date()) {
      const parsed = new URL(url, 'http://demo.invalid')
      const verb = method.toUpperCase()
      if (verb !== 'GET' && verb !== 'HEAD') {
        return { status: 403, body: { detail: DEMO_READONLY_DETAIL } }
      }
      const { status, body } = read(safeDecode(parsed.pathname), parsed.searchParams, now)
      // The digest schedule is already in the visitor's clock; everything else is shifted.
      const shifted = parsed.pathname === '/digest' ? shiftDigest(body, deltaMs) : shiftTimestamps(body, deltaMs)
      return { status, body: shifted }
    },
    nextLiveMatch() {
      const pool = baseMatches.filter((match) => typeof match.product_key === 'string')
      const template = pool[liveCounter % Math.max(pool.length, 1)] ?? baseMatches[0]
      liveCounter += 1
      const nowIso = new Date(Date.now() - deltaMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const id = 1_000_000 + liveCounter
      const match: Row = {
        ...structuredClone(template),
        id,
        matched_at: nowIso,
        created_at: nowIso,
        group_key: `demo-live-${id}`,
        grouped_match_ids: [id],
        seen_count: 1,
        message_link: `https://example.com/oferta/ao-vivo-${id}`,
        deliveries: ((template.deliveries ?? []) as Row[]).map((delivery, index) => ({
          ...delivery,
          id: id * 10 + index,
          created_at: nowIso,
          delivered_at: nowIso,
        })),
      }
      liveMatches.unshift(match)
      return shiftTimestamps(match, deltaMs)
    },
  }
}

function shiftDigest(body: unknown, deltaMs: number): unknown {
  if (body === null || typeof body !== 'object') return body
  const { next_run_at_local, next_run_at_utc, ...rest } = body as Row
  return { ...(shiftTimestamps(rest, deltaMs) as Row), next_run_at_local, next_run_at_utc }
}
