import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixturesJson from './fixtures.json'
import { DemoEventSource, LIVE_FIRST_DELAY_MS, LIVE_INTERVAL_MS, installDemoStatic } from './install'
import type { DemoFixtures } from './mockApi'

const fixtures = fixturesJson as unknown as DemoFixtures

describe('installDemoStatic', () => {
  const realFetch = window.fetch
  const realEventSource = window.EventSource

  beforeEach(() => {
    vi.useFakeTimers()
    DemoEventSource.hub.sources.clear()
    DemoEventSource.hub.timer = null
  })

  afterEach(() => {
    vi.useRealTimers()
    window.fetch = realFetch
    window.EventSource = realEventSource
  })

  it('answers fetch from the fixtures and refuses writes', async () => {
    installDemoStatic(fixtures)

    const rules = await fetch('/rules')
    expect(rules.status).toBe(200)
    expect(Array.isArray(await rules.json())).toBe(true)

    const write = await fetch('/rules', { method: 'POST', body: '{}' })
    expect(write.status).toBe(403)
    expect(await write.json()).toEqual({ detail: 'Modo demonstração: alterações desativadas.' })
  })

  it('keeps the stream connected and emits a fictional match now and then', async () => {
    installDemoStatic(fixtures)
    const source = new EventSource('/events')
    const opened = vi.fn()
    const matched = vi.fn()
    source.onopen = opened
    source.addEventListener('match', matched)

    await vi.advanceTimersByTimeAsync(1)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(matched).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LIVE_FIRST_DELAY_MS)
    expect(matched).toHaveBeenCalledTimes(1)
    const matches = (await (await fetch('/matches')).json()) as { id: number }[]
    expect(matches[0].id).toBeGreaterThan(1_000_000)

    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(matched).toHaveBeenCalledTimes(2)

    source.close()
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS * 2)
    expect(matched).toHaveBeenCalledTimes(2)
  })
})
