import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S12-01 / S12-04: visual baseline of both themes. Opt-in (`VISUAL=1`) so the
 * everyday suite stays free of font/platform-sensitive pixel comparisons.
 *
 * The screenshots are NOT versioned (`e2e/visual-baseline/` is git-ignored):
 * they depend on the OS/browser that rendered them, and the app runs on
 * Windows in production. The baseline is generated locally, at a reference
 * commit, and compared after the change under test:
 *
 *   git checkout <reference commit>            # e.g. the tip of dev before a theme change
 *   VISUAL=1 VISUAL_STYLES_OUT=/tmp/before npx playwright test e2e/visual.spec.ts --update-snapshots=all
 *   git checkout <commit under test>
 *   VISUAL=1 VISUAL_STYLES_OUT=/tmp/after npx playwright test e2e/visual.spec.ts        # pixels, threshold 0.02
 *   node scripts/compare-computed-styles.mjs /tmp/before /tmp/after                    # exact
 *
 * (S12-03: generate the baseline on the tip of dev BEFORE the dark palette
 * lands, then compare after it, light theme only.)
 *
 * Pixels alone cannot prove a refactor "identical": Chromium's blur/backdrop
 * filters leave a few pixels off by 1 level between runs of the same page.
 * So the screenshot check uses a small colour threshold, and the exact proof is
 * the computed-style dump: with VISUAL_STYLES_OUT=<dir> every shot also writes
 * the computed colour-bearing styles of every element (and the navbar's SVG
 * filter markup) to <dir>/<shot>.json, which `scripts/compare-computed-styles.mjs`
 * diffs between two runs. Same computed values = same paint, regardless of
 * raster noise.
 *
 * One serial run over one fresh database: empty states first, then a seeded
 * dataset that covers every visual variant (all status pills, all category
 * tiles, Aurora Glow, grouped "Visto em", rule in edit, toast, tooltip, error
 * and empty states). Dynamic text (clock times, uptime) is overwritten with
 * constants; the SSE connection is a controllable fake so its three states are
 * deterministic.
 */
test.skip(process.env.VISUAL !== '1', 'visual baseline is opt-in: set VISUAL=1')
// S12-04: the theme under test (`VISUAL_THEME=light|dark`, default light). It is
// the browser's colour scheme with the preference on "Sistema", the same path a
// user's OS takes. Every shot name carries the theme, so both can share a folder.
const THEME = process.env.VISUAL_THEME === 'dark' ? 'dark' : 'light'
test.describe.configure({ mode: 'serial', timeout: 300_000 })
// Times are shown in the viewer's local zone (S13-01), so what a shot shows
// depends on the machine's timezone. Pin it, and stop the page clock at the
// start of each test, so a baseline does not depend on the hour it was taken
// (e.g. "Matches hoje" between 21h and 24h in UTC-3).
test.use({ timezoneId: 'UTC', colorScheme: THEME })

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const

const FAKE_EVENT_SOURCE = `
  window.__es = []
  window.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 0; window.__es.push(this) }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  window.__setSse = (state) => {
    for (const es of window.__es) {
      if (state === 'open' && es.onopen) es.onopen({})
      if (state === 'error' && es.onerror) es.onerror({})
    }
  }
`

// Text that changes with the clock. It is overwritten with a constant of the
// same shape instead of masked: a mask would hide it, but a column whose width
// follows the text (Fontes' "Último match") still shifts by a pixel between runs.
const DYNAMIC_TEXT: Array<[selector: string, text: string]> = [
  ['.match-card__timestamp', 'Hoje, 00:00'],
  ['.historico-table__time', 'Hoje, 00:00'],
  ['td[data-label="Último match"]', '01/01/2026, 00:00:00'],
  ['.saude-tile__detail', 'v0.1.0 · tempo ativo 1h 1min'],
]

async function freezeDynamicText(page: Page) {
  await page.evaluate((entries) => {
    for (const [selector, text] of entries) {
      for (const el of document.querySelectorAll(selector)) {
        // Only the uptime line of Saúde's Ambiente tile, not its sibling tiles.
        if (selector === '.saude-tile__detail' && !(el.textContent ?? '').includes('tempo ativo')) continue
        el.textContent = text
      }
    }
  }, DYNAMIC_TEXT)
}

// Route matcher on the API path only: a glob such as "**" + "/rules*" would also
// swallow Vite's /src/api/rules.ts module request.
const api = (path: string) => (url: URL) => url.pathname === path

const COLOR_PROPERTIES = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'box-shadow',
  'text-shadow',
  'filter',
  'backdrop-filter',
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'caret-color',
  'text-decoration-color',
  'opacity',
]

/** Computed colour-bearing style of every element (and its ::before/::after),
 * keyed by a stable structural path, plus the inline SVG filter markup. */
async function collectComputedStyles(page: Page): Promise<string> {
  return page.evaluate((properties) => {
    const out: Record<string, Record<string, string>> = {}
    const pathOf = (el: Element): string => {
      const parts: string[] = []
      for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
        const index = node.parentElement ? Array.prototype.indexOf.call(node.parentElement.children, node) : 0
        parts.unshift(`${node.tagName.toLowerCase()}[${index}]`)
      }
      return parts.join('>') || 'html'
    }
    const read = (style: CSSStyleDeclaration) => {
      const values: Record<string, string> = {}
      for (const property of properties) values[property] = style.getPropertyValue(property)
      return values
    }
    for (const el of [document.documentElement, ...document.querySelectorAll('body, body *')]) {
      const key = pathOf(el)
      out[key] = read(getComputedStyle(el))
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(el, pseudo)
        if (style.content !== 'none' && style.content !== 'normal') out[`${key}${pseudo}`] = read(style)
      }
    }
    const filters = [...document.querySelectorAll('svg filter')].map((el) => el.outerHTML)
    return JSON.stringify({ styles: out, filters }, null, 1)
  }, COLOR_PROPERTIES)
}

async function shoot(
  page: Page,
  name: string,
  viewport: string,
  options: { fullPage?: boolean; keepScroll?: boolean } = {},
) {
  // A viewport-only shot depends on where the last click scrolled the page;
  // start from the top unless the shot is about a hovered element.
  if (options.fullPage === false && !options.keepScroll) await page.evaluate(() => window.scrollTo(0, 0))
  // A run that silently rendered the other theme would compare nothing useful.
  await expect(page.locator('html')).toHaveAttribute('data-theme', THEME)
  // Let fonts and async loads settle before the pixels are read.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
  await freezeDynamicText(page)
  const stylesDir = process.env.VISUAL_STYLES_OUT
  if (stylesDir) {
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(path.join(stylesDir, `${THEME}-${name}-${viewport}.json`), await collectComputedStyles(page))
  }
  await expect(page).toHaveScreenshot(`${THEME}-${name}-${viewport}.png`, {
    fullPage: options.fullPage ?? true,
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 0,
    // Absorbs the 1-2 level raster noise of blur/backdrop filters (see above);
    // any real colour change is far above it.
    threshold: 0.02,
  })
}

async function eachViewport(page: Page, body: (viewport: string) => Promise<void>) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await body(viewport.name)
  }
}

// Aurora Glow spins forever and the nav pill/toast animate on entry: freeze all
// of it from the first paint, so the computed-style dumps (taken before the
// screenshot) and the pixels see the same static state.
const FREEZE_MOTION = `
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(style)
  })
`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_EVENT_SOURCE)
  await page.addInitScript(FREEZE_MOTION)
  await page.clock.setFixedTime(new Date())
})

test('empty states, before anything is seeded', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Senha')).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'login-anonymous', v))

  await page.getByLabel('Senha').fill('senha-errada')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'login-error', v))

  await apiLogin(page)
  for (const [route, name] of [
    ['/feed', 'feed-empty'],
    ['/historico', 'historico-empty'],
    ['/regras', 'regras-empty'],
    ['/fontes', 'fontes-empty'],
  ] as const) {
    await page.goto(route)
    await page.waitForTimeout(400)
    await eachViewport(page, (v) => shoot(page, name, v))
  }
})

test('seeded data across every screen', async ({ page }) => {
  await page.goto('/')
  const csrf = await apiLogin(page)

  const sourceA = await apiPost<{ id: number }>(page, '/sources', csrf, { name: 'Urubu das Promoções', telegram_chat_id: '-100101' })
  const sourceB = await apiPost<{ id: number }>(page, '/sources', csrf, { name: 'CMdias', telegram_chat_id: '-100102' })
  await apiPost(page, '/sources', csrf, { name: 'Grupo Sem Uso', telegram_chat_id: '-100103' })

  const rules = {
    phone: await apiPost<{ id: number }>(page, '/rules', csrf, { name: 'iPhone até R$ 5.000', include_terms: 'iphone', max_price_cents: 500000 }),
    gpu: await apiPost<{ id: number }>(page, '/rules', csrf, { name: 'RTX 5070', include_terms: 'rtx 5070, 5070ti', exclude_terms: 'usada, defeito', max_price_cents: 700000 }),
    audio: await apiPost<{ id: number }>(page, '/rules', csrf, { name: 'Fones e consoles', include_terms: 'fone, ps5, notebook' }),
    idle: await apiPost<{ id: number }>(page, '/rules', csrf, { name: 'Regra sem matches', include_terms: 'nadaaqui' }),
  }
  const gabriel = await apiPost<{ id: number }>(page, '/recipients', csrf, { name: 'Gabriel', telegram_chat_id: '901', allowlisted: true })
  const namorada = await apiPost<{ id: number }>(page, '/recipients', csrf, { name: 'Namorada', telegram_chat_id: '902', allowlisted: true })
  await apiPost(page, '/recipients', csrf, { name: 'Sem autorização', telegram_chat_id: '903', allowlisted: false })

  // `link` is the message's Telegram address: the ones that have it show "Abrir
  // promoção" in Feed and Histórico, the ones without it show "Sem link" (S13-03).
  const send = (source: { id: number }, rule: { id: number }, text: string, recipients = [gabriel.id, namorada.id], link?: string) =>
    apiPost(page, '/demo/messages', csrf, { source_id: source.id, rule_id: rule.id, recipient_ids: recipients, text, link })

  // Category tiles: phone, laptop, headphones, gaming, generic.
  await send(sourceA, rules.phone, 'iPhone 15 128GB Apple por R$ 3.899 https://exemplo.com/iphone', undefined, 'https://t.me/c/101/1')
  await send(sourceA, rules.phone, 'iPhone 15 128GB Apple por R$ 4.200 https://exemplo.com/iphone2')
  await send(sourceB, rules.gpu, 'Placa de vídeo RTX 5070 Ti 16GB à vista R$ 4.516 no pix ou R$ 4.999 no cartão https://exemplo.com/gpu', undefined, 'https://t.me/c/102/2')
  await send(sourceB, rules.audio, 'Notebook Acer Aspire 5 por R$ 2.799 https://exemplo.com/nb')
  await send(sourceA, rules.audio, 'Fone Bluetooth JBL Tune por R$ 199 https://exemplo.com/fone', undefined, 'https://t.me/c/101/3')
  await send(sourceB, rules.audio, 'PS5 Slim Digital 1TB com desconto por R$ 3.299 https://exemplo.com/ps5')
  await send(sourceA, rules.audio, 'Fone gamer sem preço no texto https://exemplo.com/semprec')
  // Same promotion from a second source inside the grouping window → "Visto em".
  await send(sourceB, rules.phone, 'iPhone 15 128GB Apple por R$ 3.899 https://exemplo.com/iphone-b')
  // A title the card/table cut at the rule term (blank line after it) → tooltip.
  await send(
    sourceA,
    rules.gpu,
    'Placa de vídeo rtx 5070 gamer com resfriamento triplo\n\nEdição especial limitada com frete grátis para todo o Brasil e garantia estendida R$ 5.990 https://exemplo.com/gpu-long',
    [gabriel.id],
  )
  // No recipients at all → "Sem destinatário".
  await send(sourceA, rules.audio, 'Fone de ouvido barato por R$ 49 https://exemplo.com/fone-barato', [])

  // ---- Feed ----
  await page.goto('/feed')
  await expect(page.getByText('PS5 Slim Digital').first()).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'feed', v))

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: /^RTX 5070/ }).click()
  await shoot(page, 'feed-rule-selected', '1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shoot(page, 'feed-rule-selected', '390')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => (window as unknown as { __setSse: (s: string) => void }).__setSse('open'))
  await shoot(page, 'feed-sse-open', '1440')
  await page.evaluate(() => (window as unknown as { __setSse: (s: string) => void }).__setSse('error'))
  await shoot(page, 'feed-sse-error', '1440')

  // Tooltip on a title the card cut short.
  await page.getByRole('button', { name: /^Todas as regras/ }).click()
  await page.locator('.tooltip').first().hover()
  await page.waitForTimeout(300)
  await shoot(page, 'feed-tooltip', '1440', { fullPage: false, keepScroll: true })

  // Offline banner.
  await page.context().setOffline(true)
  await page.waitForTimeout(300)
  await eachViewport(page, (v) => shoot(page, 'feed-offline', v))
  await page.context().setOffline(false)

  // Mobile navigation expanded.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/feed')
  await page.locator('.nav-mascot').click()
  await page.waitForTimeout(500)
  await shoot(page, 'nav-mobile-expanded', '390', { fullPage: false })

  // ---- Histórico ----
  await page.goto('/historico')
  await expect(page.getByText('PS5 Slim Digital').first()).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'historico', v))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.tooltip').first().hover()
  await page.waitForTimeout(300)
  await shoot(page, 'historico-tooltip', '1440', { fullPage: false, keepScroll: true })
  // Keyboard focus on the row action: the shared focus ring on "Abrir promoção".
  // The pointer leaves the title first, or its tooltip would stay in the shot.
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await page.getByRole('link', { name: /^Abrir promoção: / }).first().focus()
  await shoot(page, 'historico-focus-open', '1440', { fullPage: false, keepScroll: true })
  await page.locator('.theme-toggle__button').focus()
  await shoot(page, 'theme-toggle-focus', '1440', { fullPage: false })
  await page.getByLabel('Regra').selectOption({ label: 'Regra sem matches' })
  await expect(page.getByText('Nenhum match encontrado com esses filtros.')).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'historico-filtered-empty', v))

  // ---- Regras ----
  await page.goto('/regras')
  await expect(page.getByText('Regra sem matches').first()).toBeVisible()
  await page.waitForTimeout(400)
  await eachViewport(page, (v) => shoot(page, 'regras', v))

  await page.setViewportSize({ width: 1440, height: 900 })
  const rtxRow = page.locator('tr', { hasText: 'RTX 5070' }).first()
  await rtxRow.getByRole('button', { name: 'Editar' }).click()
  await page.waitForTimeout(300)
  await shoot(page, 'regras-editing', '1440')
  await page.setViewportSize({ width: 390, height: 844 })
  await shoot(page, 'regras-editing', '390')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Cancelar' }).click()
  await page.locator('tr', { hasText: 'iPhone até' }).first().getByRole('button', { name: 'Testar' }).click()
  await page.getByLabel('Mensagem de exemplo').fill('iphone 15 por 3000')
  await shoot(page, 'regras-tester', '1440')

  await page.locator('tr', { hasText: 'iPhone até' }).first().getByRole('button', { name: 'Limpar histórico' }).click()
  await expect(page.getByRole('heading', { name: /Limpar histórico:/ })).toBeVisible()
  await shoot(page, 'regras-clear-confirm', '1440')
  await page.getByRole('button', { name: 'Cancelar' }).click()

  // Validation error in the rail + create toast.
  await page.getByLabel(/Nome/).fill('Sem termos')
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await shoot(page, 'regras-form-error', '1440', { fullPage: false })
  await page.getByLabel(/Nome/).fill('Regra do toast')
  await page.getByLabel(/Termos incluídos/).fill('toastitem')
  await page.getByLabel(/Termos incluídos/).press('Enter')
  // The toast dismisses itself after 4s: hold the page clock while it is shot.
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expect(page.getByRole('status')).toContainText('Regra criada.')
  await eachViewport(page, (v) => shoot(page, 'regras-toast', v, { fullPage: false }))
  await page.clock.resume()

  // ---- Fontes ----
  await page.goto('/fontes')
  await expect(page.getByText('Urubu das Promoções').first()).toBeVisible()
  await page.waitForTimeout(400)
  await eachViewport(page, (v) => shoot(page, 'fontes', v))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await shoot(page, 'fontes-form', '1440')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.waitForTimeout(300)
  await shoot(page, 'fontes-form-submitted', '1440')

  // ---- Error states of the two match lists ----
  await page.route(api('/matches'), (route) => route.fulfill({ status: 500, body: 'boom' }))
  for (const [route, name] of [
    ['/feed', 'feed-error'],
    ['/historico', 'historico-error'],
  ] as const) {
    await page.goto(route)
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.waitForTimeout(300)
    await eachViewport(page, (v) => shoot(page, name, v))
  }
  await page.unroute(api('/matches'))

  // ---- Login (authenticated view) ----
  await page.goto('/')
  await page.waitForTimeout(600)
  await eachViewport(page, (v) => shoot(page, 'login-authenticated', v))
})

test('Saúde: adapter and SSE states, notification result', async ({ page }) => {
  await page.goto('/')
  const csrf = await apiLogin(page)
  await apiPost(page, '/recipients', csrf, { name: 'Gabriel', telegram_chat_id: '901', allowlisted: true })
  await apiPost(page, '/sources', csrf, { name: 'Urubu das Promoções', telegram_chat_id: '-100101' })

  const health = (telegram: string, bot: string) => ({
    status: 'ok',
    env: 'development',
    version: '0.1.0',
    uptime_seconds: 3661,
    telegram: { configured: telegram !== 'not_configured', state: telegram },
    bot: { configured: bot === 'configured', state: bot },
  })

  for (const [telegram, bot] of [
    ['not_configured', 'not_configured'],
    ['connecting', 'configured'],
    ['connected', 'configured'],
    ['reconnecting', 'configured'],
    ['blocked', 'not_configured'],
  ] as const) {
    await page.route(api('/health'), (route) => route.fulfill({ json: health(telegram, bot) }))
    await page.goto('/saude')
    await expect(page.getByText('Ambiente')).toBeVisible()
    await page.waitForTimeout(300)
    await eachViewport(page, (v) => shoot(page, `saude-${telegram}`, v))
    await page.unroute(api('/health'))
  }

  await page.route(api('/health'), (route) => route.fulfill({ json: health('connected', 'configured') }))
  await page.goto('/saude')
  await expect(page.getByText('Ambiente')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const state of ['open', 'error'] as const) {
    await page.evaluate((s) => (window as unknown as { __setSse: (s: string) => void }).__setSse(s), state)
    await shoot(page, `saude-sse-${state}`, '1440')
  }

  await page.getByLabel('Destinatário').selectOption({ label: 'Gabriel' })
  await page.route(api('/notifications/test'), (route) =>
    route.fulfill({ json: { delivered: true, status: 'sent', recipient_id: 1, chat_id: '901' } }),
  )
  await page.getByRole('button', { name: 'Enviar teste' }).click()
  await expect(page.getByText('Entregue com sucesso.')).toBeVisible()
  await shoot(page, 'saude-test-delivered', '1440')

  await page.unroute(api('/notifications/test'))
  await page.route(api('/notifications/test'), (route) =>
    route.fulfill({ status: 403, json: { detail: 'recipient must be active and allowlisted' } }),
  )
  await page.getByRole('button', { name: 'Enviar teste' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await shoot(page, 'saude-test-error', '1440')

  // Health request failing: the page's error state.
  await page.unroute(api('/health'))
  await page.route(api('/health'), (route) => route.fulfill({ status: 500, body: 'boom' }))
  await page.goto('/saude')
  await expect(page.getByRole('alert').first()).toBeVisible()
  await eachViewport(page, (v) => shoot(page, 'saude-health-error', v))
})

test('every delivery-status pill and category tile, with crafted matches', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  const at = '2026-01-01T12:00:00Z'
  const delivery = (status: string, id: number) => [
    { id, recipient_id: 1, status, delivered_at: status === 'sent' ? at : null, created_at: at },
  ]
  const base = { source_id: 1, rule_id: 1, price_cents: 100000, price_cash_cents: null, price_card_cents: null, message_link: null, matched_at: at, created_at: at, is_lowest_price_ever: false, grouped_source_ids: null }
  const cases: Array<[string, string, string[]]> = [
    ['iPhone 15 entregue', 'sent', ['sent']],
    ['Notebook falhou', 'failed', ['failed']],
    ['Fone histórico', 'historical', ['historical']],
    ['PS5 agrupado', 'grouped', ['grouped']],
    ['Produto não autorizado', 'not_allowlisted', ['not_allowlisted']],
    ['Produto notificação desativada', 'not_configured', ['not_configured']],
    ['Produto duplicado', 'duplicate', ['duplicate']],
    ['Produto pendente', 'other', ['other']],
    ['Produto sem destinatário', 'none', []],
  ]
  const matches = cases.map(([text, , statuses], index) => ({
    ...base,
    id: index + 1,
    message_text: text,
    is_lowest_price_ever: index === 0,
    deliveries: statuses.flatMap((status) => delivery(status, index + 1)),
  }))
  await page.route(api('/matches'), (route) => route.fulfill({ json: matches }))
  await page.route(api('/rules'), (route) => route.fulfill({ json: [{ id: 1, name: 'Regra', include_terms: 'x', exclude_terms: null, max_price_cents: 900000, active: true, created_at: at, lowest_price_cents: 100000 }] }))
  await page.route(api('/sources'), (route) => route.fulfill({ json: [{ id: 1, name: 'Fonte', telegram_chat_id: '-1', active: true, created_at: at }] }))
  await page.route(api('/recipients'), (route) => route.fulfill({ json: [{ id: 1, name: 'Gabriel', telegram_chat_id: '901', allowlisted: true, active: true, created_at: at }] }))

  for (const route of ['/feed', '/historico']) {
    await page.goto(route)
    await expect(page.getByText('Produto pendente').first()).toBeVisible()
    await eachViewport(page, (v) => shoot(page, `pills${route.replace('/', '-')}`, v))
  }
})
