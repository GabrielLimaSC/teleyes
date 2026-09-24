import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S14-08 (07/07b): the product panel — real backend (`/demo/messages`,
 * same as the rest of this suite), a fictional demo product whose title is
 * a real "model fingerprint" the S14-01 `product_key` function recognises
 * (brand + model code + variant), so the seeded match actually carries a
 * non-null `product_key` and `GET /products/{key}` has something to answer.
 *
 * The scratch backend persists for the whole file (one shared SQLite,
 * `fullyParallel: false`), so every test's card is found by its own unique
 * source name (`Loja Demo Painel <tag>`) rather than by the shared,
 * intentionally repeated product title — otherwise later tests would match
 * earlier tests' leftover cards too.
 *
 * S14-05 groups feed entries by product_key + price by default
 * (`group_duplicates`, on unless a caller turns it off), and every test
 * here deliberately reuses the same product title/price so the panel has a
 * real product to show — under grouping, every seed after the first would
 * fold into that first match instead of getting its own card, and this
 * file's whole "find by unique source name" strategy would stop finding
 * anything. `seedProduct` turns grouping off for this scratch backend
 * before creating anything, once is enough since the toggle is one row.
 */

interface Seed {
  title: string
  card: Locator
}

let groupingDisabled = false

async function seedProduct(page: Page, tag: string, title: string, price: string): Promise<Seed> {
  // A random suffix — not just `tag` — keeps `telegram_chat_id` unique even
  // when the same spec runs more than once against the same scratch backend
  // (e.g. `--repeat-each`), which otherwise 500s on the source/recipient's
  // UNIQUE constraint on the second run.
  const uniqueTag = `${tag}-${Math.random().toString(36).slice(2, 8)}`
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  if (!groupingDisabled) {
    await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: false })
    groupingDisabled = true
  }
  const sourceName = `Loja Demo Painel ${uniqueTag}`
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: sourceName,
    telegram_chat_id: `demo-painel-${uniqueTag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra Painel ${uniqueTag}`,
    include_terms: title.split(' ')[0].toLowerCase(),
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Demo Painel ${uniqueTag}`,
    telegram_chat_id: `demo-painel-recipient-${uniqueTag}`,
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: `${title} por R$ ${price}`,
  })
  await page.goto('/feed')
  const card = page.locator('.match-card', { hasText: sourceName })
  await expect(card).toBeVisible()
  return { title, card }
}

async function openPanel(page: Page, seed: Seed) {
  await seed.card.getByRole('button', { name: /Abrir produto/ }).click()
  await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()
}

test.describe('product panel — abrir/fechar (07b)', () => {
  test('opens from the trigger and closes from the × button', async ({ page }) => {
    const seed = await seedProduct(page, 'x1', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    await openPanel(page, seed)

    await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
    await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
    await expect(page).toHaveURL(/feed$/)
  })

  test('closes with Escape', async ({ page }) => {
    const seed = await seedProduct(page, 'x2', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    await openPanel(page, seed)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
  })

  test('closes on a click outside the panel', async ({ page }) => {
    const seed = await seedProduct(page, 'x3', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    await openPanel(page, seed)

    await page.getByRole('heading', { name: 'Feed ao vivo' }).click()
    await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
  })

  test('closes on the browser back button, and the deep link leaves the URL', async ({ page }) => {
    const seed = await seedProduct(page, 'x4', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    await openPanel(page, seed)
    await expect(page).toHaveURL(/produto=/)

    await page.goBack()
    await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
    await expect(page).not.toHaveURL(/produto=/)
  })

  test('closes on the browser back button and returns focus to the trigger that opened it', async ({ page }) => {
    const seed = await seedProduct(page, 'x4b', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    const trigger = seed.card.getByRole('button', { name: /Abrir produto/ })
    await trigger.click()
    await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()

    await page.goBack()
    await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })

  test('the title itself also opens the panel', async ({ page }) => {
    const seed = await seedProduct(page, 'x5', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')

    await seed.card.getByRole('button', { name: seed.title }).click()
    await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()
  })
})

test('deep link survives a full reload (F5)', async ({ page }) => {
  const seed = await seedProduct(page, 'f5', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
  await openPanel(page, seed)
  const url = page.url()

  await page.reload()
  await expect(page).toHaveURL(url)
  await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()
})

test('focus returns to the trigger that opened the panel once it closes', async ({ page }) => {
  const seed = await seedProduct(page, 'focus', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
  const trigger = seed.card.getByRole('button', { name: /Abrir produto/ })
  await trigger.click()
  await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()

  await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
  await expect(trigger).toBeFocused()
})

test('opening a second product swaps the panel content instead of closing it', async ({ page }) => {
  const first = await seedProduct(page, 'swap-a', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
  const second = await seedProduct(page, 'swap-b', 'Notebook Asus TUF Gaming A15', '4.299')

  await first.card.getByRole('button', { name: /Abrir produto/ }).click()
  await expect(page.getByRole('heading', { name: first.title })).toBeVisible()

  await second.card.getByRole('button', { name: /Abrir produto/ }).click()
  await expect(page.getByRole('heading', { name: second.title })).toBeVisible()
  await expect(page.getByRole('heading', { name: first.title })).not.toBeVisible()
  // Still one panel, not a close+reopen — the grid stays split throughout.
  await expect(page.locator('.product-panel-layout')).toHaveAttribute('data-panel-phase', 'open')
})

test('prefers-reduced-motion: opens with a 120ms fade only, no grid/translate transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const seed = await seedProduct(page, 'motion', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
  await openPanel(page, seed)

  const panel = page.locator('.product-panel')
  const transition = await panel.evaluate((el) => getComputedStyle(el).transitionProperty)
  expect(transition).toBe('opacity')
  const duration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(duration).toBe('0.12s')
})

test('below 960px the panel is a full-screen sheet with a drag-to-close handle', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const seed = await seedProduct(page, 'sheet', 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
  await openPanel(page, seed)

  const panel = page.locator('.product-panel')
  await expect(panel).toHaveClass(/product-panel--sheet/)
  const position = await panel.evaluate((el) => getComputedStyle(el).position)
  expect(position).toBe('fixed')

  // `openPanel` only waits for the heading to exist — Playwright's
  // "visible" doesn't require opacity > 0, so it resolves while the sheet
  // is still mid-slide (07b's 320ms translateY(100%) → 0 on open). Reading
  // the grabber's bounding box that early lands on stale, still-animating
  // coordinates: the drag then starts somewhere that isn't the handle
  // (sometimes still inside the panel body, which drops the gesture
  // entirely; sometimes outside it, which closes via the unrelated
  // click-outside handler instead of the drag), and is the real source of
  // this test's flakiness. Wait out the same 320ms the CSS transition
  // takes before measuring the grabber for real.
  await page.waitForTimeout(360)

  const grabber = page.locator('.product-panel__grabber')
  const box = await grabber.boundingBox()
  if (!box) throw new Error('grabber not found')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let offset = 20; offset <= 300; offset += 20) {
    await page.mouse.move(startX, startY + offset)
    await page.waitForTimeout(10)
  }
  await page.mouse.up()

  await expect(page.getByRole('heading', { name: seed.title })).not.toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`opens and shows real data in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    const seed = await seedProduct(page, `theme-${theme}`, 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB', '5.749')
    await openPanel(page, seed)

    await expect(page.locator('.product-panel').getByText('R$ 5.749,00').first()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  })
}
