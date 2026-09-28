import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S14-08 parte 2 (rodada 2) / S14-13: the product panel's "Alvo de preço",
 * "Criar regra disso", "Silenciar 7 dias"/"Reativar" and "Editar dados"
 * actions, wired the same way from both the Feed and Histórico pages —
 * real backend (`/demo/messages`, same pattern as product-panel.spec.ts/
 * feedv2.spec.ts), one shared scratch SQLite for the whole file
 * (`fullyParallel: false`), so every seed gets a random tag in its title/
 * rule/source names to never fold into another test's card under
 * "Agrupar duplicatas" (which keys on product_key + price) or collide on a
 * unique source/recipient `telegram_chat_id`.
 */

interface Seed {
  csrfToken: string
  ruleId: number
  title: string
  productKey: string
}

let groupingDisabled = false

async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'same-origin' })
    return (await response.json()) as unknown
  }, path) as Promise<T>
}

async function seedPanelProduct(page: Page, tag: string, titleBase: string, price: string): Promise<Seed> {
  const uniqueTag = `${tag}-${Math.random().toString(36).slice(2, 8)}`
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  if (!groupingDisabled) {
    await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: false })
    groupingDisabled = true
  }
  const title = `${titleBase} ${uniqueTag}`
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Loja Demo Ações ${uniqueTag}`,
    telegram_chat_id: `demo-acoes-${uniqueTag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra Ações ${uniqueTag}`,
    include_terms: titleBase.split(' ')[0].toLowerCase(),
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Demo Ações ${uniqueTag}`,
    telegram_chat_id: `demo-acoes-recipient-${uniqueTag}`,
    allowlisted: true,
  })
  const demo = await apiPost<{ match_id: number }>(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: `${title} por R$ ${price}`,
  })
  const matches = await apiGet<Array<{ id: number; product_key: string | null }>>(page, '/matches')
  const productKey = matches.find((match) => match.id === demo.match_id)?.product_key ?? null
  expect(productKey, 'seeded message must carry a real product_key').not.toBeNull()
  return { csrfToken, ruleId: rule.id, title, productKey: productKey as string }
}

async function openPanelFromFeed(page: Page, seed: Seed) {
  await page.goto('/feed')
  const card = page.locator('.match-card', { hasText: seed.title })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /Abrir produto/ }).click()
  await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()
  return card
}

async function openPanelFromHistorico(page: Page, seed: Seed) {
  await page.goto('/historico')
  const row = page.locator('.historico-table__row', { hasText: seed.title })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: /Abrir produto/ }).first().click()
  await expect(page.getByRole('heading', { name: seed.title })).toBeVisible()
  return row
}

for (const [origin, openPanel] of [
  ['Feed', openPanelFromFeed],
  ['Histórico', openPanelFromHistorico],
] as const) {
  test.describe(`painel do produto a partir do ${origin} — ações (S14-08 parte 2 rodada 2)`, () => {
    test(`"Salvar alvo" digitando "5.749" grava 574900 centavos na regra e mostra R$ 5.749,00 no painel`, async ({
      page,
    }) => {
      const seed = await seedPanelProduct(page, `${origin}-alvo`, 'Placa de vídeo Painel Alvo', '10.000')
      await openPanel(page, seed)
      const panel = page.locator('.product-panel')

      const input = panel.getByRole('textbox', { name: 'Avise-me abaixo de' })
      await input.fill('5.749')
      await panel.getByRole('button', { name: 'Salvar alvo' }).click()

      await expect(
        page.getByRole('status').filter({ hasText: 'Alvo de preço salvo.' }),
      ).toBeVisible()
      // The panel reloads the rule's real target after saving — the field
      // reformats to the pt-BR value that was actually persisted, R$
      // 5.749,00, never a mis-parsed R$ 5,75 (the exact bug S14-13 fixes).
      await expect(input).toHaveValue('5.749,00')

      const rules = await apiGet<Array<{ id: number; target_price_cents: number | null }>>(page, '/rules')
      const savedRule = rules.find((candidate) => candidate.id === seed.ruleId)
      expect(savedRule?.target_price_cents).toBe(574_900)
    })

    test('"Criar regra disso" navega para /regras?produto=<key> com o formulário pré-preenchido', async ({
      page,
    }) => {
      const seed = await seedPanelProduct(page, `${origin}-criarregra`, 'Placa de vídeo Painel CriarRegra', '4.299')
      await openPanel(page, seed)
      const panel = page.locator('.product-panel')

      await panel.getByRole('button', { name: 'Criar regra disso' }).click()

      await expect(page).toHaveURL(new RegExp(`/regras\\?produto=${encodeURIComponent(seed.productKey)}`))
      await expect(page.getByText('pré-preenchida do produto')).toBeVisible()
      await expect(page.getByLabel(/Nome/)).toHaveValue(seed.title)
    })

    test('"Silenciar 7 dias" vira "Reativar" no painel, e reativar volta ao rótulo original', async ({ page }) => {
      const seed = await seedPanelProduct(page, `${origin}-silenciar`, 'Placa de vídeo Painel Silenciar', '3.199')
      await openPanel(page, seed)
      const panel = page.locator('.product-panel')

      await panel.getByRole('button', { name: 'Silenciar 7 dias' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Produto silenciado por 7 dias.' }),
      ).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Reativar' })).toBeVisible()

      await panel.getByRole('button', { name: 'Reativar' }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Silenciamento removido.' }),
      ).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Silenciar 7 dias' })).toBeVisible()
    })

    test('editar o preço no painel atualiza o card/linha por trás dele, sem fechar o painel', async ({ page }) => {
      const seed = await seedPanelProduct(page, `${origin}-editar`, 'Monitor Painel Editar', '6.991')
      const listItem = await openPanel(page, seed)
      const panel = page.locator('.product-panel')

      await panel.getByRole('button', { name: 'Editar dados' }).click()
      const priceInput = panel.getByRole('textbox', { name: 'Preço', exact: true })
      await expect(priceInput).toBeVisible()
      await priceInput.fill('5.749')
      await panel.getByRole('button', { name: 'Salvar correção' }).click()

      // The panel itself shows the corrected price…
      await expect(panel.getByText('R$ 5.749,00').first()).toBeVisible()
      // …and so does the card/row still open behind it — `onEdited` refetches
      // the page's own match list instead of leaving it stale.
      await expect(listItem.getByText('R$ 5.749,00')).toBeVisible()
      await expect(listItem.getByText('R$ 6.991,00')).not.toBeVisible()
    })
  })
}
