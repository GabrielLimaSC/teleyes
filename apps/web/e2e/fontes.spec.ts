import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S21-11: Fontes v2 — KPIs, table with 7-day bars, "Adicionar fonte" rail.
// The e2e backend has no Telegram configured, so the "Da minha conta" tab
// shows its empty state; the group list itself is covered by the vitest suite.

async function seed(page: Page, tag: string) {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Grupo ${tag}`,
    telegram_chat_id: `-100${tag.length}${Date.now() % 100000}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra ${tag}`,
    include_terms: tag.toLowerCase(),
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Dest ${tag}`,
    telegram_chat_id: `${Date.now() % 1000000}`,
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: `${tag.toLowerCase()} promoção por R$ 100`,
  })
  return { csrfToken, source }
}

test('shows the KPI strip, the 7-day bars and a real last match', async ({ page }) => {
  await seed(page, 'Kpis')
  await page.goto('/fontes')

  const kpis = page.locator('.fontes-kpis')
  await expect(kpis.getByText('Fontes ativas')).toBeVisible()
  await expect(kpis.getByText('Avaliações · hoje')).toBeVisible()
  await expect(kpis.getByText('Matches · 7d')).toBeVisible()
  await expect(kpis.getByText('Último match')).toBeVisible()

  const row = page.getByRole('row', { name: /Grupo Kpis/ })
  await expect(row).toBeVisible()
  await expect(row.locator('.fontes-bars__bar')).toHaveCount(7)
  await expect(row.locator('[data-label="Último match"]')).toContainText(/agora|há /)
  await expect(row.locator('[data-label="Matches · 7d"]')).toHaveText('1')
})

test('adds a source by chat_id through the rail, then edits and deletes it with confirmation', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/fontes')

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Grupo Rail E2E')
  await page.getByLabel('Chat ID do Telegram').fill('-1009911')
  await page.getByRole('button', { name: 'Salvar' }).click()
  const row = page.getByRole('row', { name: /Grupo Rail E2E/ })
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: /Mais ações da fonte/ }).click()
  await page.getByRole('menuitem', { name: 'Editar' }).click()
  await expect(page.getByRole('heading', { name: 'Editar fonte' })).toBeVisible()
  await page.getByLabel('Nome', { exact: true }).fill('Grupo Rail Editado')
  await page.getByRole('button', { name: 'Salvar' }).click()
  const edited = page.getByRole('row', { name: /Grupo Rail Editado/ })
  await expect(edited).toBeVisible()

  await edited.getByRole('button', { name: /Mais ações da fonte/ }).click()
  await page.getByRole('menuitem', { name: 'Excluir' }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Excluir' }).click()
  await expect(page.getByRole('row', { name: /Grupo Rail Editado/ })).toHaveCount(0)
})

test('pausing a source updates the KPI and the status switch', async ({ page }) => {
  await seed(page, 'Pausa')
  await page.goto('/fontes')

  const row = page.getByRole('row', { name: /Grupo Pausa/ })
  await row.getByRole('switch').click()
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.fontes-kpis')).toContainText(/\d+ pausadas?/)
})

test('"Da minha conta" explains when Telegram is not configured and links to the wizard', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/fontes')

  await page.getByRole('tab', { name: 'Da minha conta' }).click()
  await expect(page.getByText('Telegram ainda não configurado')).toBeVisible()
  await page.getByRole('link', { name: 'assistente de configuração' }).click()
  await expect(page).toHaveURL(/\/configuracao/)
})

for (const theme of ['light', 'dark'] as const) {
  test(`has no horizontal overflow on a phone and keeps the rail below the cards (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await seed(page, `Mobile${theme}`)
    await page.addInitScript((value) => localStorage.setItem('teleyes.theme', value), theme)
    await page.goto('/fontes')

    const card = page.getByRole('row', { name: new RegExp(`Grupo Mobile${theme}`) })
    await expect(card).toBeVisible()
    expect((await page.locator('.fontes-table thead').boundingBox())!.width).toBeLessThanOrEqual(1)
    const [scrollWidth, clientWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ])
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)

    const cardBox = await card.boundingBox()
    const railBox = await page.locator('#fontes-rail').boundingBox()
    expect(railBox!.y).toBeGreaterThan(cardBox!.y + cardBox!.height - 1)
  })
}
