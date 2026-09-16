import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

function rowByExactName(page: Page, name: string) {
  return page
    .locator('tr')
    .filter({ has: page.locator('.crud-table__name', { hasText: new RegExp(`^${name}$`) }) })
}

test('creates, edits, duplicates and pauses a rule against the real API', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  await page.getByRole('button', { name: '+ Nova regra' }).click()
  await page.getByLabel(/Nome/).fill('RTX 5070 E2E')
  await page.getByLabel(/Termos incluídos/).fill('rtx 5070')
  await page.getByLabel('Termos bloqueados').fill('usada')
  await page.getByLabel(/Preço máximo/).fill('5500')
  await page.getByRole('button', { name: 'Salvar' }).click()

  const createdRow = rowByExactName(page, 'RTX 5070 E2E')
  await expect(createdRow).toBeVisible()
  await expect(createdRow.getByRole('cell', { name: 'rtx 5070', exact: true })).toBeVisible()
  await expect(createdRow.getByRole('cell', { name: 'R$ 5.500,00' })).toBeVisible()
  await expect(createdRow.getByRole('button', { name: 'ativa' })).toBeVisible()

  // edit
  await createdRow.getByRole('button', { name: 'Editar' }).click()
  await page.getByLabel(/Nome/).fill('RTX 5070 Ti E2E')
  await page.getByRole('button', { name: 'Salvar' }).click()
  const editedRow = rowByExactName(page, 'RTX 5070 Ti E2E')
  await expect(editedRow).toBeVisible()

  // duplicate
  await editedRow.getByRole('button', { name: 'Duplicar' }).click()
  await expect(page.getByRole('heading', { name: 'Nova regra' })).toBeVisible()
  await expect(page.getByLabel(/Nome/)).toHaveValue('RTX 5070 Ti E2E (cópia)')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await expect(rowByExactName(page, 'RTX 5070 Ti E2E \\(cópia\\)')).toBeVisible()

  // pause the original — one-directional per the API (no reactivate endpoint)
  await editedRow.getByRole('button', { name: 'ativa' }).click()
  await expect(editedRow.getByRole('button', { name: 'pausada' })).toBeVisible()
})

test('creating a source with a duplicate chat id shows the real 409 as feedback', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/fontes')

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome').fill('Grupo E2E Conflito')
  await page.getByLabel('Chat ID do Telegram').fill('-100555')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await expect(rowByExactName(page, 'Grupo E2E Conflito')).toBeVisible()

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome').fill('Outro grupo')
  await page.getByLabel('Chat ID do Telegram').fill('-100555')
  await page.getByRole('button', { name: 'Salvar' }).click()

  await expect(page.getByRole('alert')).toBeVisible()
})

test('the Regras and Destinatários tables share the same container width and left edge (S7-01)', async ({
  page,
}) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  const wraps = page.locator('.crud-page .crud-table-wrap')
  await expect(wraps).toHaveCount(2)

  const rulesBox = await wraps.nth(0).boundingBox()
  const recipientsBox = await wraps.nth(1).boundingBox()
  expect(rulesBox).not.toBeNull()
  expect(recipientsBox).not.toBeNull()
  // Same left edge and width — the S7-01 bug was DestinatariosSection
  // rendering outside RegrasPage's 900px-centered `.crud-page` container,
  // stretching full-width instead of sharing it.
  expect(recipientsBox!.x).toBeCloseTo(rulesBox!.x, 0)
  expect(recipientsBox!.width).toBeCloseTo(rulesBox!.width, 0)
})

test('creates and pauses a recipient from the Regras page', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  await page.getByRole('button', { name: '+ Novo destinatário' }).click()
  await page.getByLabel('Nome').fill('Namorada E2E')
  await page.getByLabel('Chat ID do Telegram').fill('555444')
  await page.getByRole('button', { name: 'Salvar' }).click()

  const row = rowByExactName(page, 'Namorada E2E')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'ativa' }).click()
  await expect(row.getByRole('button', { name: 'pausada' })).toBeVisible()
})

test('clears a rule\'s match history against the real API, with a confirmation showing the real count (S10-04)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Limpeza',
    telegram_chat_id: '-100556',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'RTX 5070 Limpeza E2E',
    include_terms: 'gadgetlimpezae2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Limpeza',
    telegram_chat_id: '985',
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetlimpezae2e por R$ 199',
  })

  await page.goto('/feed')
  await expect(page.getByText('gadgetlimpezae2e por R$ 199')).toBeVisible()

  await page.goto('/regras')
  const row = rowByExactName(page, 'RTX 5070 Limpeza E2E')
  await row.getByRole('button', { name: 'Limpar histórico' }).click()

  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: RTX 5070 Limpeza E2E' }),
  ).toBeVisible()
  await expect(page.getByText('Isso apaga 1 match desta')).toBeVisible()

  await page.getByRole('button', { name: 'Apagar histórico' }).click()

  await expect(page.getByRole('status')).toHaveText('1 match apagado.×')
  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: RTX 5070 Limpeza E2E' }),
  ).not.toBeVisible()

  // Gone from the Feed for real, and the rule itself is still there, active.
  await page.goto('/feed')
  await expect(page.getByText('gadgetlimpezae2e por R$ 199')).not.toBeVisible()
  await page.goto('/regras')
  await expect(rowByExactName(page, 'RTX 5070 Limpeza E2E').getByRole('button', { name: 'ativa' })).toBeVisible()
})

test('clearing a rule with no matches shows a toast directly, no confirmation dialog (S10-04)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  await apiPost(page, '/rules', csrfToken, {
    name: 'Regra Sem Match E2E',
    include_terms: 'termoquenuncabateu',
  })

  await page.goto('/regras')
  const row = rowByExactName(page, 'Regra Sem Match E2E')
  await row.getByRole('button', { name: 'Limpar histórico' }).click()

  await expect(page.getByRole('status')).toContainText('Nenhum match encontrado')
  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: Regra Sem Match E2E' }),
  ).not.toBeVisible()
})
