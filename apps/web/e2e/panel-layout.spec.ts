import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S20-01: opening the product panel must never break the page layout — no
 * horizontal scroll, the Histórico table keeps readable columns, topbar and
 * titles stay aligned. Measured (scrollWidth vs clientWidth, column widths),
 * not eyeballed, at the two widths Gabriel reported (1440 and 1000) in both
 * themes. SHOTS_DIR=<dir> also saves screenshots (docs / PR evidence).
 */

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1000, height: 800 },
]
const THEMES = ['light', 'dark'] as const

async function seed(page: Page): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 8)
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: false })
  const title = `GPU PNY NVIDIA GeForce RTX 5070 OC ${tag}`
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `CAÇA PREÇO DO ROCHA ${tag}`,
    telegram_chat_id: `demo-layout-${tag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `RTX 5070 ${tag}`,
    include_terms: 'gpu',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Destinatario ${tag}`,
    telegram_chat_id: `demo-layout-r-${tag}`,
    allowlisted: true,
  })
  for (const price of ['4.984,36', '4.799,00', '699,00']) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `${title} por R$ ${price}`,
    })
  }
  return title
}

// The theme follows the system preference by default (theme/theme.ts).
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.emulateMedia({ colorScheme: theme })
}

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, `page scrolls horizontally (${scrollWidth} > ${clientWidth})`).toBeLessThanOrEqual(
    clientWidth,
  )
}

async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.width}px, ${theme}`, () => {
      test.use({ viewport })

      test('Feed: opening the product panel adds no horizontal scroll', async ({ page }) => {
        const title = await seed(page)
        await setTheme(page, theme)
        await page.goto('/feed')
        const card = page.locator('.match-card', { hasText: title }).first()
        await expect(card).toBeVisible()
        await expectNoHorizontalScroll(page)
        await shot(page, `feed-${viewport.width}-${theme}-closed`)

        await card.getByRole('button', { name: /Abrir produto/ }).click()
        await expect(page.getByRole('heading', { name: title })).toBeVisible()
        await page.waitForTimeout(500)

        await expectNoHorizontalScroll(page)
        await shot(page, `feed-${viewport.width}-${theme}-panel`)
        // The page header (title) stays inside the viewport, aligned.
        const heading = page.getByRole('heading', { name: 'Feed ao vivo' })
        const box = await heading.boundingBox()
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
        // The panel itself is fully inside the viewport.
        const panel = page.locator('.product-panel')
        const panelBox = await panel.boundingBox()
        expect(panelBox).not.toBeNull()
        expect(panelBox!.x).toBeGreaterThanOrEqual(0)
        expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width + 1)
      })

      test('Histórico: opening the panel keeps the table readable, no horizontal scroll', async ({ page }) => {
        const title = await seed(page)
        await setTheme(page, theme)
        await page.goto('/historico')
        const row = page.locator('.historico-table__row', { hasText: title }).first()
        await expect(row).toBeVisible()
        await shot(page, `historico-${viewport.width}-${theme}-closed`)

        await row.getByRole('button', { name: /Abrir produto/ }).first().click()
        await expect(page.getByRole('heading', { name: title })).toBeVisible()
        await page.waitForTimeout(500)

        await expectNoHorizontalScroll(page)
        await shot(page, `historico-${viewport.width}-${theme}-panel`)
        const productColumn = await row.locator('.historico-table__product').boundingBox()
        expect(productColumn!.width).toBeGreaterThanOrEqual(160)
        // Every metric tile keeps its text (no clipped "R$ 4.984,3…").
        const tiles = page.locator('.historico-stats__value')
        const count = await tiles.count()
        for (let index = 0; index < count; index += 1) {
          const clipped = await tiles
            .nth(index)
            .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
          expect(clipped, `metric tile ${index} is clipped`).toBe(false)
        }
        const headingBox = await page.getByRole('heading', { name: 'Histórico' }).boundingBox()
        expect(headingBox?.x ?? -1).toBeGreaterThanOrEqual(0)
      })
    })
  }
}

// S20-03: the open/close animation is compositor-only. By construction: the
// panel is a fixed overlay, the page content keeps its exact width (so no
// reflow when it opens or closes) and carries no filter/opacity, and only
// transform/opacity ever have a transition on the panel.
for (const pageName of ['feed', 'historico'] as const) {
  test(`${pageName}: the panel is a fixed overlay that never reflows or filters the page`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const title = await seed(page)
    await page.goto(`/${pageName}`)
    const row =
      pageName === 'feed'
        ? page.locator('.match-card', { hasText: title }).first()
        : page.locator('.historico-table__row', { hasText: title }).first()
    const trigger = row.getByRole('button', { name: /Abrir produto/ }).first()
    await expect(trigger).toBeVisible()
    const content = page.locator('.product-panel-layout__content')
    const widthBefore = (await content.boundingBox())!.width

    await trigger.click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await page.waitForTimeout(500)

    expect((await content.boundingBox())!.width).toBe(widthBefore)
    const contentStyle = await content.evaluate((element) => {
      const style = getComputedStyle(element)
      return { filter: style.filter, opacity: style.opacity }
    })
    expect(contentStyle).toEqual({ filter: 'none', opacity: '1' })
    const panelStyle = await page.locator('.product-panel').evaluate((element) => {
      const style = getComputedStyle(element)
      return { position: style.position, properties: style.transitionProperty.split(',').map((value) => value.trim()) }
    })
    expect(panelStyle.position).toBe('fixed')
    for (const property of panelStyle.properties) expect(['transform', 'opacity']).toContain(property)

    await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
    await expect(page.locator('.product-panel')).toHaveCount(0)
    expect((await content.boundingBox())!.width).toBe(widthBefore)
  })
}
