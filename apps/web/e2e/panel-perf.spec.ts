import { test } from '@playwright/test'
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
const RUNS = Number(process.env.PANEL_PERF_RUNS ?? '3')

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
  for (let index = 0; index < 24; index += 1) {
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
}

async function sampleDuring(page: Page, cdp: CDPSession, durationMs: number, action: () => Promise<void>): Promise<Sample> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean }
    w.__frames = []
    w.__stop = false
    const tick = (now: number) => {
      w.__frames.push(now)
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const before = await metrics(cdp)
  await action()
  await page.waitForTimeout(durationMs)
  const after = await metrics(cdp)
  const stamps = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean }
    w.__stop = true
    return w.__frames
  })
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
  }
}

function report(label: string, sample: Sample) {
  const pct = sample.frames > 1 ? ((sample.over20 / (sample.frames - 1)) * 100).toFixed(0) : '0'
  console.log(
    `PERF ${label}: frames=${sample.frames} maxGap=${sample.maxGap.toFixed(1)}ms >20ms=${sample.over20} (${pct}%) >33ms=${sample.over33} ` +
      `LayoutCount=${sample.layoutCount} RecalcStyle=${sample.recalcCount} LayoutDuration=${sample.layoutMs.toFixed(1)}ms Script=${sample.scriptMs.toFixed(1)}ms maxGapFrame=#${sample.maxGapAt}`,
  )
}

for (const pageName of ['feed', 'historico'] as const) {
  test(`${pageName}: panel open/close frame times (${THROTTLE}x CPU)`, async ({ page }) => {
    test.setTimeout(90_000)
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
    for (let run = 1; run <= RUNS; run += 1) {
      const open = await sampleDuring(page, cdp, 600, () => trigger().click())
      report(`${pageName} open #${run}`, open)
      const close = await sampleDuring(page, cdp, 400, () => page.getByRole('button', { name: 'Fechar painel do produto' }).click())
      report(`${pageName} close #${run}`, close)
      await page.waitForTimeout(300)
    }
  })
}
