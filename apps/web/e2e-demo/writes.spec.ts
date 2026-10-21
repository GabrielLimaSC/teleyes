import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const DEMO_PASSWORD = 'demo-teleyes'
const READ_ONLY_MESSAGE = 'Modo demonstração: alterações desativadas.'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Senha').fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()
}

/** Every refused write must end the same way: the demo toast, no crash. */
function watchForCrashes(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function expectRefusal(page: Page) {
  await expect(page.locator('.toast')).toContainText(READ_ONLY_MESSAGE)
}

function ruleRow(page: Page, name: string) {
  return page.locator('tr').filter({ has: page.locator('.crud-table__name').getByText(name, { exact: true }) })
}

test('Regras: pause, create, delete, apply, clear history and silence degrade gracefully', async ({ page }) => {
  const errors = watchForCrashes(page)
  await signIn(page)
  await page.goto('/regras')
  // Rule rows only (the recipients table below also uses .crud-table__name).
  const rows = page.locator('tr').filter({ hasText: /exemplo/ })
  await expect(ruleRow(page, 'SSD NVMe exemplo')).toBeVisible()
  const before = await rows.count()
  expect(before).toBeGreaterThanOrEqual(5)

  // Pause (and the table stays, which an inline list error would have replaced).
  await ruleRow(page, 'SSD NVMe exemplo').getByRole('switch', { name: 'ativa' }).click()
  await expectRefusal(page)
  expect(await rows.count()).toBe(before)

  // Resume a paused rule.
  await page.locator('.toast__close').click()
  await ruleRow(page, 'Monitor 27 exemplo').getByRole('switch', { name: 'pausada' }).click()
  await expectRefusal(page)
  expect(await rows.count()).toBe(before)

  // Create.
  await page.locator('.toast__close').click()
  await page.getByLabel(/Nome/).fill('Teclado exemplo')
  await page.getByLabel(/Termos incluídos/).fill('teclado exemplo')
  await page.getByLabel(/Termos incluídos/).press('Enter')
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expectRefusal(page)
  expect(await rows.count()).toBe(before)

  // Apply rules.
  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Aplicar regras' }).click()
  await expectRefusal(page)

  // Delete.
  await page.locator('.toast__close').click()
  const ssd = ruleRow(page, 'SSD NVMe exemplo')
  await ssd.getByRole('button', { name: /^Mais ações da regra/ }).click()
  await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click()
  const confirmDelete = page.getByRole('button', { name: /^(Excluir|Confirmar)/ })
  if (await confirmDelete.count()) await confirmDelete.last().click()
  await expectRefusal(page)
  expect(await rows.count()).toBe(before)

  // Clear a rule's history (confirmation dialog, then a DELETE).
  await page.locator('.toast__close').click()
  await ruleRow(page, 'SSD NVMe exemplo').getByRole('button', { name: /^Mais ações da regra/ }).click()
  await page.getByRole('menuitem', { name: 'Limpar histórico', exact: true }).click()
  await page.getByRole('button', { name: 'Apagar histórico' }).click()
  await expectRefusal(page)
  await page.getByRole('button', { name: 'Cancelar' }).click()

  // Delivery settings.
  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Salvar entrega' }).click()
  await expectRefusal(page)

  // Silence ("Reativar" in the muted list is a DELETE).
  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Reativar' }).first().click()
  await expectRefusal(page)

  // The dry-run still works in the read-only demo.
  await page.locator('.toast__close').click()
  await page.getByLabel(/Termos incluídos/).fill('ssd nvme exemplo')
  await page.getByLabel(/Termos incluídos/).press('Enter')
  await page.getByRole('complementary').getByRole('button', { name: 'Testar' }).click()
  await expect(page.locator('.toast')).toHaveCount(0)

  expect(errors).toEqual([])
})

test('Fontes and Destinatários: create, pause and delete degrade gracefully', async ({ page }) => {
  const errors = watchForCrashes(page)
  await signIn(page)
  await page.goto('/fontes')
  const names = page.locator('.crud-table__name')
  await expect(names.first()).toBeVisible()
  const before = await names.count()

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome').fill('Grupo novo demo')
  await page.getByLabel('Chat ID do Telegram').fill('demo:novo')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByRole('alert').filter({ hasText: READ_ONLY_MESSAGE })).toBeVisible()
  await expectRefusal(page)
  await page.getByRole('button', { name: 'Cancelar' }).click()

  await page.locator('.toast__close').click()
  await page.getByRole('switch', { name: 'ativa' }).first().click()
  await expectRefusal(page)
  expect(await names.count()).toBe(before)

  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Excluir' }).first().click()
  const confirm = page.getByRole('button', { name: /^(Excluir|Confirmar)/ })
  if ((await confirm.count()) > 1) await confirm.last().click()
  await expectRefusal(page)
  expect(await names.count()).toBe(before)

  expect(errors).toEqual([])
})

test('Feed: silence, group toggle and digest degrade gracefully', async ({ page }) => {
  const errors = watchForCrashes(page)
  await signIn(page)
  await page.goto('/feed')
  await expect(page.locator('.match-card').first()).toBeVisible()
  const cards = await page.locator('.match-card').count()

  await page.getByRole('switch', { name: /Agrupar duplicatas/ }).click()
  await expectRefusal(page)

  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Mais ações' }).first().click()
  await page.getByRole('menuitem', { name: /Silenciar/ }).click()
  await expectRefusal(page)
  expect(await page.locator('.match-card').count()).toBe(cards)

  // Price target on a card: PATCH /rules/{id}.
  await page.locator('.toast__close').click()
  await page.getByRole('button', { name: 'Definir alvo' }).first().click()
  await page.getByRole('textbox', { name: /Avise-me abaixo de|alvo/i }).first().fill('15000')
  await page.getByRole('button', { name: /^Salvar/ }).first().click()
  await expectRefusal(page)

  expect(errors).toEqual([])
})

test('Histórico and Saúde: the product panel and the test notification degrade gracefully', async ({ page }) => {
  const errors = watchForCrashes(page)
  await signIn(page)
  await page.goto('/historico')
  await page.locator('.historico-table__title--button').first().click()
  await page.getByRole('button', { name: 'Silenciar 7 dias' }).click()
  await expectRefusal(page)
  await expect(page.getByRole('button', { name: 'Fechar painel do produto' })).toBeVisible()

  await page.goto('/saude')
  await expect(page.getByText('Demonstração').first()).toBeVisible()
  const select = page.locator('select').first()
  await select.selectOption({ index: 1 })
  await page.getByRole('button', { name: /Enviar teste/ }).click()
  await expect(page.getByText(READ_ONLY_MESSAGE).first()).toBeVisible()

  expect(errors).toEqual([])
})
