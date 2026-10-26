import { createMockApi } from './mockApi'
import type { DemoFixtures, MockApi } from './mockApi'

/** First fictional offer after 25 s, then one every ~50 s: alive, never frantic. */
export const LIVE_FIRST_DELAY_MS = 25_000
export const LIVE_INTERVAL_MS = 50_000

type Listener = (event: MessageEvent<string>) => void

/** `EventSource` stand-in: always connected, and now and then "receives" a match. */
export class DemoEventSource extends EventTarget {
  static hub: { api: MockApi | null; sources: Set<DemoEventSource>; timer: ReturnType<typeof setTimeout> | null } = {
    api: null,
    sources: new Set(),
    timer: null,
  }

  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: Listener | null = null
  readyState = 0
  readonly url: string
  readonly withCredentials = false

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      DemoEventSource.hub.sources.add(this)
      DemoEventSource.scheduleNext(LIVE_FIRST_DELAY_MS)
      const event = new Event('open')
      this.onopen?.(event)
      this.dispatchEvent(event)
    }, 0)
  }

  close(): void {
    this.readyState = 2
    DemoEventSource.hub.sources.delete(this)
  }

  private static scheduleNext(delay: number): void {
    const { hub } = DemoEventSource
    if (hub.timer !== null) return
    hub.timer = setTimeout(() => {
      hub.timer = null
      if (hub.sources.size === 0 || hub.api === null) return
      const match = hub.api.nextLiveMatch()
      for (const source of hub.sources) {
        source.dispatchEvent(new MessageEvent('match', { data: JSON.stringify({ match_id: match.id }) }))
      }
      DemoEventSource.scheduleNext(LIVE_INTERVAL_MS)
    }, delay)
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Replaces `fetch` and `EventSource` so the dashboard never needs a backend. */
export function installDemoStatic(fixtures: DemoFixtures): MockApi {
  const api = createMockApi(fixtures)
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), window.location.href)
    if (url.origin !== window.location.origin) return realFetch(input, init)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const { status, body } = api.handle(method, `${url.pathname}${url.search}`)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  DemoEventSource.hub.api = api
  window.EventSource = DemoEventSource as unknown as typeof EventSource
  return api
}

/** Entry point used by `main.tsx`; the fixtures are a separate lazy chunk. */
export async function bootDemoStatic(): Promise<void> {
  const fixtures = (await import('./fixtures.json')).default as unknown as DemoFixtures
  installDemoStatic(fixtures)
}
