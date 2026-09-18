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

  expect(csv).toContain('Produto,Regra,Fonte,Hora,Preço,Entrega')
  expect(csv).toContain('csvitem exportado por R$ 250')
  expect(csv).toContain('Regra E2E CSV')
  expect(csv).toContain('Grupo E2E CSV')
  expect(csv).toContain('250,00')
})
