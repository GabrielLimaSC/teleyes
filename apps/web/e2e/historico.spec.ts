import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

test('Histórico shows real stat tiles matching known matches (S11-04)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Stats',
    telegram_chat_id: '-100820',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Stats',
    include_terms: 'statsitem',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Stats',
    telegram_chat_id: '820',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'statsitem um por R$ 100',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'statsitem dois por R$ 300',
  })

  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Stats' })
  await expect(page.getByText('statsitem um por R$ 100')).toBeVisible()
  await expect(page.getByText('statsitem dois por R$ 300')).toBeVisible()

  // 2 matches conhecidos, preços R$ 100 e R$ 300 — média R$ 200, menor R$ 100.
  const countTile = page.locator('.historico-stats__tile', { hasText: 'Matches no período' })
  await expect(countTile).toContainText('2')
  const avgTile = page.locator('.historico-stats__tile', { hasText: 'Preço médio' })
  await expect(avgTile).toContainText('200,00')
  const lowestTile = page.locator('.historico-stats__tile', { hasText: 'Menor preço' })
  await expect(lowestTile).toContainText('100,00')
})

test('Histórico exports a CSV whose rows match the real matches on screen (S11-04)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E CSV',
    telegram_chat_id: '-100821',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E CSV',
    include_terms: 'csvitem',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E CSV',
    telegram_chat_id: '821',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'csvitem exportado por R$ 250',
  })

  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E CSV' })
  await expect(page.getByText('csvitem exportado por R$ 250')).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Exportar CSV' }).click(),
  ])

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const csv = Buffer.concat(chunks).toString('utf-8')

  expect(csv).toContain('Produto,Regra,Fonte,Hora,Preço,Detalhe do preço,Entrega,Para')
  expect(csv).toContain('csvitem exportado por R$ 250')
  expect(csv).toContain('Regra E2E CSV')
  expect(csv).toContain('Grupo E2E CSV')
  expect(csv).toContain('250,00')
  // Recipient shown on the row ("Para:") is in the CSV too.
  await expect(page.getByText('Para: Gabriel E2E CSV')).toBeVisible()
  expect(csv).toContain('Gabriel E2E CSV')
})

// S13-03: every Histórico row has an "Abrir promoção" action (or an honest
// "Sem link"), on the wide and the narrow layout, in both themes.
const LINK_VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const
const LINK_THEMES = ['light', 'dark'] as const
const SHOTS_DIR = process.env.S13_03_SHOTS_DIR ?? 'e2e/.scratch'

test('Histórico row opens the promotion, with a named link, a touch target and a focus ring; no-link row is explicit (S13-03)', async ({
  page,
  context,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Abrir',
    telegram_chat_id: '-100830',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Abrir',
    include_terms: 'abririt',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Abrir',
    telegram_chat_id: '830',
    allowlisted: true,
  })
  const withLinkText = 'abririt notebook gamer por R$ 3.899'
  const noLinkText = 'abririt fone antigo por R$ 199'
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: withLinkText,
    link: 'https://t.me/c/123456/830',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: noLinkText,
  })

  for (const theme of LINK_THEMES) {
    await page.emulateMedia({ colorScheme: theme })
    for (const viewport of LINK_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/historico')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Abrir' })
      const rows = page.locator('.historico-table__row:not(.historico-table__row--head)')
      await expect(rows).toHaveCount(2)

      const link = page.getByRole('link', { name: `Abrir promoção: ${withLinkText}` })
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', 'https://t.me/c/123456/830')
      await expect(link).toHaveAttribute('target', '_blank')
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      // Comfortable touch target, and nothing pushed past the viewport.
      const box = await link.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(40)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)

      // The row without a link says so, and offers no link of its own.
      const noLinkRow = rows.filter({ hasText: noLinkText })
      await expect(noLinkRow.locator('.historico-table__no-link', { hasText: 'Sem link' })).toBeVisible()
      await expect(noLinkRow.getByRole('link')).toHaveCount(0)
      await expect(noLinkRow.locator('.historico-table__no-link')).toHaveAttribute(
        'title',
        /Telegram não forneceu/,
      )

      await page.screenshot({ path: `${SHOTS_DIR}/s13-03-historico-${theme}-${viewport.name}.png` })

      // Keyboard focus draws the shared focus ring (a box-shadow token).
      await page.keyboard.press('Shift')
      await link.focus()
      await expect(link).toBeFocused()
      const ring = await link.evaluate((el) => getComputedStyle(el).boxShadow)
      expect(ring).not.toBe('none')

      await page.screenshot({ path: `${SHOTS_DIR}/s13-03-historico-${theme}-${viewport.name}-focus.png` })
    }
  }

  // Click really opens the promotion in a new tab.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Abrir' })
  await context.route('https://t.me/**', (route) => route.fulfill({ status: 200, body: '' }))
  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: `Abrir promoção: ${withLinkText}` }).click(),
  ])
  await newPage.waitForLoadState('load')
  expect(newPage.url()).toBe('https://t.me/c/123456/830')
  await newPage.close()

  // The CSV carries the same link.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Exportar CSV' }).click(),
  ])
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const csv = Buffer.concat(chunks).toString('utf-8')
  expect(csv).toContain('Detalhe do preço,Entrega,Para,Link')
  expect(csv).toContain('https://t.me/c/123456/830')
})
