import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S21-07 (F8): destinatário por regra, contra o backend real. Tag aleatória
 * porque o backend é compartilhado entre os specs.
 */
test('Regras: coluna Destinatários, card com regras escolhidas e aviso de quem não recebe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  const ruleA = await apiPost<{ id: number }>(page, '/rules', csrf, { name: `Alfa ${tag}`, include_terms: `alfa${tag}` })
  await apiPost(page, '/rules', csrf, { name: `Beta ${tag}`, include_terms: `beta${tag}` })
  await apiPost(page, '/recipients', csrf, {
    name: `Alex ${tag}`,
    telegram_chat_id: `a-${tag}`,
    allowlisted: true,
    rules_mode: 'selected',
    rule_ids: [ruleA.id],
    notify_common: false,
  })

  await page.goto('/regras')
  const alfa = page.locator('tbody', { has: page.getByText(`Alfa ${tag}`, { exact: true }) })
  const beta = page.locator('tbody', { has: page.getByText(`Beta ${tag}`, { exact: true }) })
  await expect(alfa.locator('.delivery-who')).toContainText(`só Alex ${tag}`)
  await expect(beta.locator('.delivery-who')).toContainText('ninguém recebe')

  await beta.getByRole('button', { name: new RegExp(`^Beta ${tag}`) }).click()
  await expect(beta.getByText('1 destinatário não recebe esta regra')).toBeVisible()

  const card = page.getByRole('article', { name: `Destinatário Alex ${tag}` })
  await expect(card.getByRole('button', { name: `Alfa ${tag}`, pressed: true })).toBeVisible()
  await expect(card.getByRole('button', { name: `Beta ${tag}`, pressed: false })).toBeVisible()
  await expect(card).toContainText(/1 de \d+ regras? · só preços-alvo atingidos/)

  // Uma regra a mais para o card e a coluna seguirem a mudança.
  await card.getByRole('button', { name: `Beta ${tag}` }).click()
  await card.getByRole('button', { name: 'Salvar alterações' }).click()
  await expect(card.getByText('Alterações salvas.')).toBeVisible()
  await expect(beta.locator('.delivery-who')).toContainText(`só Alex ${tag}`)
})

test('Regras: novo destinatário exige regra e tipo, mostra a prévia e cria', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  await apiPost(page, '/rules', csrf, { name: `Gama ${tag}`, include_terms: `gama${tag}` })

  await page.goto('/regras')
  const rail = page.locator('.regras-page__rail')
  await page.getByRole('button', { name: '+ Adicionar destinatário' }).click()
  await rail.getByLabel('Nome').fill(`Jordan ${tag}`)
  await rail.getByLabel('Chat ID do Telegram').fill(`j-${tag}`)
  await rail.getByRole('button', { name: 'Escolher regras' }).click()
  await expect(rail.getByRole('button', { name: 'Adicionar' })).toBeDisabled()
  await expect(rail.getByText('Escolha ao menos uma regra para continuar.')).toBeVisible()

  await rail.getByRole('checkbox', { name: `Gama ${tag}` }).check()
  await expect(rail.getByText(`Jordan ${tag} vai receber 1 regra`)).toBeVisible()
  await rail.getByRole('button', { name: 'Adicionar' }).click()

  await expect(page.getByRole('article', { name: `Destinatário Jordan ${tag}` })).toBeVisible()
})
