import { expect, test } from '@playwright/test'
import { apiLogin } from './helpers'

test('cria uma regra a partir de um modelo no modo simples e a vê na tabela (S23-05)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  await expect(page.getByLabel('Termos bloqueados')).toHaveCount(0)
  await page.getByRole('button', { name: 'SSD', exact: true }).click()
  await expect(page.getByLabel(/Nome/)).toHaveValue('SSD')
  await expect(page.getByLabel(/Até quanto você paga/)).toBeFocused()

  // The live preview comes from the real dry-run endpoint.
  await expect(page.getByTestId('rule-preview')).toContainText(/nos últimos \d+ dias/)

  await page.getByLabel(/Nome/).fill('SSD modelo E2E')
  await page.getByLabel(/Até quanto você paga/).fill('450')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  const row = page.locator('tr').filter({ hasText: 'SSD modelo E2E' })
  await expect(row).toBeVisible()
  await expect(row.locator('.wide-table__terms')).toHaveText('ssd + 1tb')
  await expect(row.getByRole('cell', { name: 'R$ 450,00' })).toBeVisible()
})

test('o modo avançado é lembrado e anunciado (S23-05)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  await page.getByRole('button', { name: 'Mais opções' }).click()
  await expect(page.getByLabel('Termos bloqueados')).toBeVisible()
  await expect(page.getByText('Modo avançado: mais opções disponíveis.')).toBeAttached()
  await expect(page.getByText(/só casa quando a mensagem tem as duas palavras/)).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Termos bloqueados')).toBeVisible()
  await page.getByRole('button', { name: 'Menos opções' }).click()
  await expect(page.getByLabel('Termos bloqueados')).toHaveCount(0)
})
