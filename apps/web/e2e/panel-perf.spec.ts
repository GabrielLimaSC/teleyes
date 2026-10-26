import { test } from '@playwright/test'
import type { Browser } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S20-02: frame-time evidence for the product panel open/close animation.
 * Opt-in (PANEL_PERF=1) — it measures, it does not assert on a machine-
 * dependent budget by default. Samples requestAnimationFrame intervals while
 * the panel opens (~600ms) and closes (~400ms) with CPU throttled (default
 * 4x, PANEL_PERF_THROTTLE) and reads the CDP LayoutCount / RecalcStyleCount /
 * LayoutDuration deltas to show whether layout runs per frame.
 *
 *   PANEL_PERF=1 npx playwright test e2e/panel-perf.spec.ts
 */

const THROTTLE = Number(process.env.PANEL_PERF_THROTTLE ?? '4')
const TRACE = process.env.PANEL_PERF_TRACE === '1'
const RUNS = Number(process.env.PANEL_PERF_RUNS ?? '3')
// S20-03: the real app has hundreds of matches; the default stays small.
const SEED_COUNT = Number(process.env.PANEL_PERF_SEED ?? '24')

test.skip(process.env.PANEL_PERF !== '1', 'opt-in: set PANEL_PERF=1')
test.use({ viewport: { width: 1440, height: 900 } })

async function seed(page: Page): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 8)
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: false })
  const title = `GPU PNY NVIDIA GeForce RTX 5070 OC ${tag}`
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `CAÇA PREÇO DO ROCHA ${tag}`,
    telegram_chat_id: `demo-perf-${tag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `RTX 5070 ${tag}`,
    include_terms: 'gpu',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Destinatario ${tag}`,
    telegram_chat_id: `demo-perf-r-${tag}`,
    allowlisted: true,
  })
  for (let index = 0; index < SEED_COUNT; index += 1) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `${title} v${index} por R$ ${(699 + index * 37).toLocaleString('pt-BR')},00`,
    })
  }
  return title
}

type Metrics = Record<string, number>

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.map((metric) => [metric.name, metric.value]))
}

interface Sample {
  frames: number
  maxGap: number
  over20: number
  over33: number
  layoutCount: number
  recalcCount: number
  layoutMs: number
  scriptMs: number
  maxGapAt: number
  loaf: number[]
  trace: Record<string, { total: number; max: number; count: number }>
  timeline: string[]
}

const TRACE_NAMES = [
  'Layout',
  'UpdateLayoutTree',
  'PrePaint',
  'Paint',
  'Layerize',
  'Commit',
  'FunctionCall',
  'EvaluateScript',
  'RasterTask',
  'ImageDecodeTask',
  'GPUTask',
  'DrawFrame',
  'FireAnimationFrame',
  'HitTest',
]

interface TraceEvent {
  name: string
  ph: string
  dur?: number
  ts: number
  tid: number
  args?: Record<string, unknown>
}

function summarizeTrace(buffer: Buffer): { trace: Sample['trace']; timeline: string[] } {
  const json = JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(json) ? json : json.traceEvents
  const out: Sample['trace'] = {}
  const timeline: string[] = []
  const threadNames = new Map<number, string>()
  for (const event of events as Array<TraceEvent & { name: string; args?: { name?: string } }>) {
    if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(event.tid, String(event.args?.name))
  }
  const t0 = Math.min(...events.filter((event) => event.ph === 'X' && event.dur !== undefined && ['Layout', 'EventDispatch'].includes(event.name)).map((event) => event.ts))
  for (const event of events) {
    if (process.env.PANEL_PERF_ALL === '1' && event.ph === 'X' && event.dur !== undefined && event.dur >= 12000) {
      timeline.push(`${((event.ts - t0) / 1000).toFixed(0)}ms *${event.name} ${(event.dur / 1000).toFixed(1)}ms ${threadNames.get(event.tid) ?? event.tid}`)
    }
    if (event.ph === 'X' && event.dur !== undefined && event.dur >= 6000 && ['Layout', 'UpdateLayoutTree', 'PrePaint', 'Paint', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame'].includes(event.name)) {
      const data = (event.args?.data ?? {}) as { type?: string; functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }
      timeline.push(`${((event.ts - t0) / 1000).toFixed(0)}ms ${event.name}${data.type ? `(${data.type})` : ''}${data.functionName !== undefined ? `[${data.functionName || 'anon'}@${(data.url ?? '').split('/').pop()}:${data.lineNumber}:${data.columnNumber}]` : ''} ${(event.dur / 1000).toFixed(1)}ms`)
    }
    if (event.ph !== 'X' || event.dur === undefined) continue
    let key = event.name
    if (event.name === 'PipelineReporter') key = 'PipelineReporter(frame)'
    else if (!TRACE_NAMES.includes(event.name)) continue
    const ms = event.dur / 1000
    const entry = (out[key] ??= { total: 0, max: 0, count: 0 })
    entry.total += ms
    entry.count += 1
    entry.max = Math.max(entry.max, ms)
  }
  timeline.sort((a, b) => parseInt(a) - parseInt(b))
  return { trace: out, timeline }
}

async function sampleDuring(browser: Browser, page: Page, cdp: CDPSession, durationMs: number, action: () => Promise<void>): Promise<Sample> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean }
    w.__frames = []
    w.__stop = false
    const tick = (now: number) => {
      w.__frames.push(now)
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    ;(w as unknown as { __loaf: number[]; __loafObserved?: boolean }).__loaf = []
    try {
      if ((w as unknown as { __loafObserved?: boolean }).__loafObserved) throw new Error('already observing')
      ;(w as unknown as { __loafObserved?: boolean }).__loafObserved = true
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) (w as unknown as { __loaf: number[] }).__loaf.push(entry.startTime, entry.duration)
      }).observe({ type: 'long-animation-frame', buffered: false })
    } catch {
      /* long-animation-frame unsupported */
    }
  })
  if (TRACE) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'gpu', 'viz'] })
  const before = await metrics(cdp)
  await action()
  await page.waitForTimeout(durationMs)
  const after = await metrics(cdp)
  const { trace, timeline } = TRACE ? summarizeTrace(await browser.stopTracing()) : { trace: {}, timeline: [] as string[] }
  const { stamps: allStamps, loaf: loafRaw, actionAt } = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean; __loaf: number[]; __actionAt: number }
    w.__stop = true
    return { stamps: w.__frames, loaf: w.__loaf, actionAt: w.__actionAt }
  })
  // Only the frames from the one that follows the click on count: whatever
  // ran before it (tracing start, the sampler's own setup) is harness noise.
  const loafAfter: number[] = []
  for (let index = 0; index < loafRaw.length; index += 2) if (loafRaw[index] + loafRaw[index + 1] >= actionAt) loafAfter.push(loafRaw[index + 1])
  const firstAfter = allStamps.findIndex((stamp) => stamp >= actionAt)
  const stamps = allStamps.slice(Math.max(0, firstAfter - 1))
  const gaps = stamps.slice(1).map((value, index) => value - stamps[index])
  return {
    frames: stamps.length,
    maxGap: Math.max(0, ...gaps),
    over20: gaps.filter((gap) => gap > 20).length,
    over33: gaps.filter((gap) => gap > 33).length,
    layoutCount: after.LayoutCount - before.LayoutCount,
    recalcCount: after.RecalcStyleCount - before.RecalcStyleCount,
    layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
    maxGapAt: gaps.indexOf(Math.max(0, ...gaps)),
    loaf: loafAfter,
    trace,
    timeline,
  }
}

function report(label: string, sample: Sample) {
  const pct = sample.frames > 1 ? ((sample.over20 / (sample.frames - 1)) * 100).toFixed(0) : '0'
  console.log(
    `PERF ${label}: frames=${sample.frames} maxGap=${sample.maxGap.toFixed(1)}ms >20ms=${sample.over20} (${pct}%) >33ms=${sample.over33} ` +
      `LayoutCount=${sample.layoutCount} RecalcStyle=${sample.recalcCount} LayoutDuration=${sample.layoutMs.toFixed(1)}ms Script=${sample.scriptMs.toFixed(1)}ms maxGapFrame=#${sample.maxGapAt} LoAF=[${sample.loaf.map((v) => v.toFixed(0)).join(',')}]`,
  )
  if (process.env.PANEL_PERF_TIMELINE === '1') console.log(`  TIMELINE ${label}: ${sample.timeline.join(' | ')}`)
  for (const [name, v] of Object.entries(sample.trace)) {
    console.log(`  TRACE ${label} ${name}: total=${v.total.toFixed(1)}ms max=${v.max.toFixed(2)}ms n=${v.count}`)
  }
}

for (const pageName of ['feed', 'historico'] as const) {
  test(`${pageName}: panel open/close frame times (${THROTTLE}x CPU)`, async ({ page, browser }) => {
    test.setTimeout(240_000)
    const title = await seed(page)
    await page.goto(`/${pageName}`)
    const trigger = () =>
      (pageName === 'feed'
        ? page.locator('.match-card', { hasText: title }).first()
        : page.locator('.historico-table__row', { hasText: title }).first()
      )
        .getByRole('button', { name: /Abrir produto/ })
        .first()
    await trigger().waitFor()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
    // Let the page finish its own start-up work (live refresh, lazy card
    // mounting) under the throttle: sample the panel, not the page load.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let last = performance.now()
          new PerformanceObserver((list) => {
            if (list.getEntries().length > 0) last = performance.now()
          }).observe({ type: 'longtask', buffered: false })
          const check = () => (performance.now() - last > 1500 ? resolve() : setTimeout(check, 250))
          check()
          setTimeout(resolve, 25_000)
        }),
    )
    if (process.env.PANEL_PERF_CSS) await page.addStyleTag({ content: process.env.PANEL_PERF_CSS })
    if (process.env.PANEL_PERF_IDLE === '1') {
      const idle = await sampleDuring(browser, page, cdp, 600, async () => {})
      report(`${pageName} idle`, idle)
      await trigger().click()
      await page.waitForTimeout(80)
      const anims = await page.evaluate(() =>
        document.getAnimations().map((animation) => {
          const effect = animation.effect as KeyframeEffect | null
          const target = effect?.target as Element | null
          const name = (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty
          return `${animation.constructor.name}:${name}:${target?.tagName}.${(target?.className ?? '').toString().slice(0, 50)}:${animation.playState}`
        }),
      )
      console.log(`  ANIMS ${pageName}: ${anims.join(' | ')}`)
      await page.waitForTimeout(600)
      await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
      await page.waitForTimeout(400)
    }
    for (let run = 1; run <= RUNS; run += 1) {
      const open = await sampleDuring(browser, page, cdp, 600, () => trigger().evaluate((element) => {
          ;(window as unknown as { __actionAt: number }).__actionAt = performance.now()
          ;(element as HTMLElement).click()
        }))
      report(`${pageName} open #${run}`, open)
      const close = await sampleDuring(browser, page, cdp, 400, () => page.getByRole('button', { name: 'Fechar painel do produto' }).evaluate((element) => {
          ;(window as unknown as { __actionAt: number }).__actionAt = performance.now()
          ;(element as HTMLElement).click()
        }))
      report(`${pageName} close #${run}`, close)
      await page.waitForTimeout(300)
    }
  })
}
