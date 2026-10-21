import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const DEMO_PASSWORD = 'demo-teleyes'
const BANNER = 'Modo demonstração — dados fictícios'
const READ_ONLY_MESSAGE = 'Modo demonstração: alterações desativadas.'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Senha').fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()
}

test('the login page announces the demo and shows the public password', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('note', { name: 'Aviso de modo demonstração' })).toHaveText(BANNER)
  await expect(page.getByTestId('demo-login-hint')).toContainText(DEMO_PASSWORD)
})

test('the feed is populated, pins a target hit and keeps the banner', async ({ page }) => {
  await signIn(page)
  await page.goto('/feed')

  await expect(page.getByRole('note', { name: 'Aviso de modo demonstração' })).toHaveText(BANNER)
  // Seeded story: at least one offer from the last 24 h reached its rule's target.
  await expect(page.getByText('Alvo atingido').first()).toBeVisible()
  const cards = page.locator('.match-card')
  expect(await cards.count()).toBeGreaterThan(5)
  await expect(page.getByText('Exemplo').first()).toBeVisible()
})

test('the rules page lists the seeded rules with sparklines', async ({ page }) => {
  await signIn(page)
  await page.goto('/regras')

  await expect(page.getByRole('note', { name: 'Aviso de modo demonstração' })).toBeVisible()
  for (const name of [
    'Placa de vídeo RTX 5090 exemplo',
    'Notebook exemplo 15 polegadas',
    'Fone bluetooth exemplo',
    'Monitor 27 exemplo',
    'SSD NVMe exemplo',
  ]) {
    await expect(page.locator('.crud-table__name').getByText(name, { exact: true })).toBeVisible()
  }
  expect(await page.locator('.rule-sparkline').count()).toBeGreaterThanOrEqual(3)
})

test('a write shows the demo message and the page keeps working', async ({ page }) => {
  await signIn(page)
  await page.goto('/regras')
  const row = page
    .locator('tr')
    .filter({ has: page.locator('.crud-table__name').getByText('SSD NVMe exemplo', { exact: true }) })

  await row.getByRole('switch', { name: 'ativa' }).click()

  const toast = page.locator('.toast')
  await expect(toast).toContainText(READ_ONLY_MESSAGE)
  // Nothing changed and nothing broke: the rule is still listed and still active.
  await expect(row.getByRole('switch', { name: 'ativa' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Regras/ }).first()).toBeVisible()

  // The same degradation on another page: Fontes.
  await page.goto('/fontes')
  await expect(page.getByText('Grupo Demo Ofertas').first()).toBeVisible()
})
