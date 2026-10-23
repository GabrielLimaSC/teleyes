import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S20-01: "Excluir anúncio" (card ⋯ menu, Histórico row) and "Excluir" in the
 * product panel — always behind a confirmation, and the list updates without
 * a reload. Real backend, random tag per seed (see product-panel-actions.spec.ts).
 */

interface Seed {
  title: string
}

async function seedProductWithTypo(page: Page): Promise<Seed> {
  const tag = Math.random().toString(36).slice(2, 8)
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: false })
  const title = `Placa Exclusao ${tag}`
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Loja Exclusao ${tag}`,
    telegram_chat_id: `demo-exclusao-${tag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra Exclusao ${tag}`,
    include_terms: 'placa',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Destinatario Exclusao ${tag}`,
    telegram_chat_id: `demo-exclusao-r-${tag}`,
    allowlisted: true,
  })
  for (const price of ['5.749,00', '699,00']) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `${title} por R$ ${price}`,
    })
  }
  return { title }
}

test('deletes a wrong-price listing from the Feed card menu, after confirming, without reloading', async ({
  page,
}) => {
  const { title } = await seedProductWithTypo(page)
  await page.goto('/feed')
  const typo = page.locator('.match-card', { hasText: title }).filter({ hasText: '699,00' })
  const fine = page.locator('.match-card', { hasText: title }).filter({ hasText: '5.749,00' })
  await expect(typo).toBeVisible()
  await expect(fine).toBeVisible()

  await typo.getByRole('button', { name: 'Mais ações' }).click()
  await page.getByRole('menuitem', { name: 'Excluir anúncio' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText(
    'Excluir este anúncio? Isso remove o registro do histórico e dos cálculos de preço. Não dá para desfazer.',
  )

  // Cancelling keeps it.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(typo).toBeVisible()

  await typo.getByRole('button', { name: 'Mais ações' }).click()
  await page.getByRole('menuitem', { name: 'Excluir anúncio' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Excluir anúncio' }).click()

  await expect(typo).toHaveCount(0)
  await expect(fine).toBeVisible()
  await expect(page.getByText('Anúncio excluído.')).toBeVisible()
})

test('deletes every record of a product from the Histórico panel, showing the count', async ({ page }) => {
  const { title } = await seedProductWithTypo(page)
  await page.goto('/historico')
  const rows = page.locator('.historico-table__row', { hasText: title })
  await expect(rows).toHaveCount(2)

  await rows.first().getByRole('button', { name: /Abrir produto/ }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: 'Excluir', exact: true }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Excluir 2 registros deste produto?')
  // The panel stays open behind the dialog (Esc/click there belong to the dialog).
  await dialog.getByRole('button', { name: 'Excluir produto' }).click()

  await expect(rows).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: title })).toHaveCount(0)
})
