import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S14-07 (06/06b): selos, ações e barra lateral do Feed v2 — real backend
 * (`/demo/messages`, same pattern as feed.spec.ts/product-panel.spec.ts).
 *
 * The scratch backend persists for the whole Playwright run (one shared
 * SQLite, `fullyParallel: false`) — every seed here uses a random suffix in
 * titles/prices so two runs of this file (or another file's own seeds)
 * never fold into each other under the "Agrupar duplicatas" grouping, which
 * keys on product_key + price alone.
 */

function uniqueTag(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2, 8)}`
}

/** A whole-reais price in a wide, effectively-collision-free range, so two
 * tests never accidentally share a product_key + price pair. */
function randomPrice(): number {
  return 3000 + Math.floor(Math.random() * 90_000)
}

async function apiPatch<T>(page: Page, path: string, csrfToken: string, data: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, csrfToken, data }) => {
      const response = await fetch(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      })
      return (await response.json()) as unknown
    },
    { path, csrfToken, data },
  ) as Promise<T>
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'same-origin' })
    return (await response.json()) as unknown
  }, path) as Promise<T>
}

interface Seed {
  csrfToken: string
  sourceId: number
  ruleId: number
  recipientId: number
}

async function seedBase(page: Page, tag: string, targetPriceCents: number | null = null): Promise<Seed> {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Fonte ${tag}`,
    telegram_chat_id: `chat-${tag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra ${tag}`,
    include_terms: tag,
    ...(targetPriceCents !== null ? { target_price_cents: targetPriceCents } : {}),
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Dest ${tag}`,
    telegram_chat_id: `dest-${tag}`,
    allowlisted: true,
  })
  return { csrfToken, sourceId: source.id, ruleId: rule.id, recipientId: recipient.id }
}

test.describe('Feed v2 — selos e ações do card (S14-07)', () => {
  test('mostra "Alvo atingido" quando o preço já bate o alvo da regra, no card e na trilha', async ({ page }) => {
    const tag = uniqueTag('alvo')
    const price = randomPrice()
    const seed = await seedBase(page, tag, price * 100)

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `Produto ${tag} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: `Produto ${tag}` })
    await expect(card).toBeVisible()
    await expect(card.getByText('Alvo atingido')).toBeVisible()

    const targetRow = page.locator('.feed-target', { hasText: `Regra ${tag}` })
    await expect(targetRow).toBeVisible()
    await expect(targetRow.getByText('atingido')).toBeVisible()
  })

  test('"Definir alvo" salva o alvo da regra e o card passa a mostrar "Alvo atingido"', async ({ page }) => {
    const tag = uniqueTag('definir')
    const price = randomPrice()
    const seed = await seedBase(page, tag) // sem alvo ainda

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `Produto ${tag} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: `Produto ${tag}` })
    await expect(card).toBeVisible()
    await expect(card.getByText('Alvo atingido')).not.toBeVisible()

    await card.getByRole('button', { name: 'Definir alvo' }).click()
    await card.getByLabel('Alvo (R$)').fill(String(price + 1))
    await card.getByRole('button', { name: 'Salvar' }).click()

    await expect(card.getByText('Alvo atingido')).toBeVisible()
  })

  test('mostra "Visto em N fontes" quando duas fontes postam o mesmo produto pelo mesmo preço', async ({ page }) => {
    const tag = uniqueTag('duas-fontes')
    const price = randomPrice()
    await page.goto('/')
    const csrfToken = await apiLogin(page)
    // Defensivo: outro arquivo de spec pode ter desligado o agrupamento.
    await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: true })

    const sourceA = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
      name: `Fonte A ${tag}`,
      telegram_chat_id: `chat-a-${tag}`,
    })
    const sourceB = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
      name: `Fonte B ${tag}`,
      telegram_chat_id: `chat-b-${tag}`,
    })
    // S14-05 groups by product_key (a "model fingerprint" over the title),
    // never the rule — this real recognised pattern (brand + model code) is
    // the same one product-panel.spec.ts already relies on to get a
    // non-null product_key. Two DIFFERENT rules on purpose: the S7-11
    // same-rule/same-price mechanism runs first and would otherwise already
    // collapse these two messages into one card before S14-05's own
    // product-based grouping ever gets a second card to fold.
    const ruleA = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
      name: `Regra A ${tag}`,
      include_terms: 'placa de vídeo',
    })
    const ruleB = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
      name: `Regra B ${tag}`,
      include_terms: 'palit',
    })
    const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
      name: `Dest ${tag}`,
      telegram_chat_id: `dest-${tag}`,
      allowlisted: true,
    })
    const title = `Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB ${tag}`

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: sourceA.id,
      rule_id: ruleA.id,
      recipient_ids: [recipient.id],
      text: `${title} por R$ ${price},00`,
    })
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: sourceB.id,
      rule_id: ruleB.id,
      recipient_ids: [recipient.id],
      text: `${title} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: title })
    await expect(card).toBeVisible()
    await expect(card.getByText('Visto em 2 fontes')).toBeVisible()
  })

  test('mostra o chip "preço não identificado" e "Corrigir" abre o painel de produto', async ({ page }) => {
    const tag = uniqueTag('sem-preco')
    const seed = await seedBase(page, tag)
    const title = `Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB ${tag}`

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      // Sem "R$" e sem vírgula decimal: packages/rules/price.extract_price
      // não reconhece nenhum valor aqui, então price_cents fica null.
      text: `${title} fora de estoque no momento, sem preço no anúncio`,
    })

    const card = page.locator('.match-card', { hasText: title })
    await expect(card).toBeVisible()
    await expect(card.getByText('preço não identificado', { exact: true })).toBeVisible()
    await expect(card.getByText('Preço não identificado', { exact: true })).toBeVisible()

    await card.getByRole('button', { name: 'Corrigir' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  })

  test('mostra o chip "editado manualmente" após uma correção de preço (S14-06)', async ({ page }) => {
    const tag = uniqueTag('editado')
    const price = randomPrice()
    const seed = await seedBase(page, tag)

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `Produto ${tag} por R$ ${price},00`,
    })
    const card = page.locator('.match-card', { hasText: `Produto ${tag}` })
    await expect(card).toBeVisible()

    const matches = await apiGet<Array<{ id: number }>>(page, `/matches?rule_id=${seed.ruleId}`)
    await apiPatch(page, `/matches/${matches[0].id}`, seed.csrfToken, { price: `R$ ${price + 10},00` })

    await page.reload()
    await expect(page.locator('.match-card', { hasText: `Produto ${tag}` }).getByText('editado manualmente')).toBeVisible()
  })

  test('"Criar regra disso" navega para /regras?produto=<key>', async ({ page }) => {
    const tag = uniqueTag('criar-regra')
    const price = randomPrice()
    const seed = await seedBase(page, tag)
    const title = `Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB ${tag}`

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `${title} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: title })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Criar regra disso' }).click()

    await expect(page).toHaveURL(/\/regras\?produto=/)
  })

  test('"Silenciar 7 dias" vira "Reativar" no card, e some pela trilha "Silenciados" ao reativar', async ({ page }) => {
    const tag = uniqueTag('silenciar')
    const price = randomPrice()
    const seed = await seedBase(page, tag)
    const title = `Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB ${tag}`

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `${title} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: title })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Silenciar 7 dias' }).click()
    await expect(card.getByRole('button', { name: 'Reativar' })).toBeVisible()

    const snoozeRow = page.locator('.feed-snooze', { hasText: title })
    await expect(snoozeRow).toBeVisible()
    await snoozeRow.getByRole('button', { name: 'Reativar' }).click()

    await expect(snoozeRow).not.toBeVisible()
    await expect(card.getByRole('button', { name: 'Silenciar 7 dias' })).toBeVisible()
  })
})

test.describe('Feed v2 — barra lateral (S14-07)', () => {
  test('o toggle "Agrupar duplicatas" reflete e grava o estado real', async ({ page }) => {
    await page.goto('/')
    const csrfToken = await apiLogin(page)
    await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: true })

    await page.goto('/feed')
    const toggle = page.getByRole('button', { name: /Agrupar duplicatas/ })
    await expect(toggle).toHaveText('Agrupar duplicatas: ligado')

    await toggle.click()
    await expect(toggle).toHaveText('Agrupar duplicatas: desligado')

    await page.reload()
    await expect(page.getByRole('button', { name: /Agrupar duplicatas/ })).toHaveText('Agrupar duplicatas: desligado')

    // Não deixa o backend compartilhado desligado para as próximas specs.
    await apiPut(page, '/settings/feed', csrfToken, { group_duplicates: true })
  })

  test('"Resumo de hoje" e o digest mostram números reais (S14-04/S14-07)', async ({ page }) => {
    const tag = uniqueTag('hoje')
    const price = randomPrice()
    const seed = await seedBase(page, tag)

    await page.goto('/feed')
    const resumoHojeBefore = page.locator('.feed-today')
    await expect(resumoHojeBefore).toBeVisible()

    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `Produto ${tag} por R$ ${price},00`,
    })

    await expect(page.locator('.match-card', { hasText: `Produto ${tag}` })).toBeVisible()

    const digest = page.locator('.feed-digest')
    await expect(digest).toBeVisible()
    await expect(digest.getByText(/Próximo envio:/)).toBeVisible()
    await expect(digest.getByLabel('Horário')).toBeVisible()
  })
})

test.describe('Feed v2 — regra 06b (cards alinhados na mesma linha)', () => {
  test('dois cards na mesma linha do grid têm a mesma altura e a base (preço/ações) alinhada', async ({ page }) => {
    const tag = uniqueTag('06b')
    const targetPrice = randomPrice()
    const priceHit = targetPrice // igual ao alvo: "Alvo atingido" (selo extra)
    const priceMiss = targetPrice + 5000 // bem acima: sem selo nenhum

    await page.goto('/')
    const csrfToken = await apiLogin(page)
    const sourceA = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
      name: `Fonte A ${tag}`,
      telegram_chat_id: `chat-a-${tag}`,
    })
    const sourceB = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
      name: `Fonte B ${tag}`,
      telegram_chat_id: `chat-b-${tag}`,
    })
    // Mesma regra pros dois — dá pra isolar exatamente os 2 cards pela
    // trilha "Filtrar por regra", nunca dependendo de quantos outros cards
    // (de outros testes, backend compartilhado) já existem no feed.
    const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
      name: `Regra ${tag}`,
      include_terms: tag,
      target_price_cents: targetPrice * 100,
    })
    const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
      name: `Dest ${tag}`,
      telegram_chat_id: `dest-${tag}`,
      allowlisted: true,
    })

    await page.goto('/feed')
    // Preços diferentes: o mecanismo S7-11 (mesma regra + mesmo preço) só
    // agrupa cards com preço idêntico, então os dois continuam cards
    // separados mesmo sob a mesma regra.
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: sourceA.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `Produto A ${tag} por R$ ${priceHit},00`,
    })
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: sourceB.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `Produto B ${tag} por R$ ${priceMiss},00`,
    })

    await page.getByRole('button', { name: new RegExp(`Regra ${tag}`) }).click()

    const cardA = page.locator('.match-card', { hasText: `Produto A ${tag}` })
    const cardB = page.locator('.match-card', { hasText: `Produto B ${tag}` })
    await expect(cardA).toBeVisible()
    await expect(cardB).toBeVisible()
    await expect(cardA.getByText('Alvo atingido')).toBeVisible()
    await expect(cardB.getByText('Alvo atingido')).not.toBeVisible()
    // Só os dois cards do teste visíveis — garante que estão na mesma linha
    // do grid de 2 colunas (primeira e única linha).
    await expect(page.locator('.feed-page__card')).toHaveCount(2)

    const boxA = await cardA.boundingBox()
    const boxB = await cardB.boundingBox()
    if (!boxA || !boxB) throw new Error('card bounding box missing')
    // Mesma linha do grid: mesmo topo, mesma altura (o CSS grid, align-items
    // stretch por padrão, estica os dois ao mais alto).
    expect(Math.abs(boxA.y - boxB.y)).toBeLessThan(2)
    expect(Math.abs(boxA.height - boxB.height)).toBeLessThan(2)

    const actionsA = await cardA.locator('.match-card__actions').boundingBox()
    const actionsB = await cardB.locator('.match-card__actions').boundingBox()
    if (!actionsA || !actionsB) throw new Error('actions bounding box missing')
    // A base (barra de ações) dos dois cards alinha, mesmo o A tendo um selo
    // a mais no cabeçalho — o `margin-top: auto` no bloco de preço é o que
    // empurra os dois para o mesmo lugar.
    expect(Math.abs(actionsA.y + actionsA.height - (actionsB.y + actionsB.height))).toBeLessThan(2)
  })
})

for (const theme of ['light', 'dark'] as const) {
  test(`Feed v2 nos dois temas e em 390px — ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    const tag = uniqueTag(`tema-${theme}`)
    const price = randomPrice()
    const seed = await seedBase(page, tag, price * 100)
    const title = `Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB ${tag}`

    await page.goto('/feed')
    await apiPost(page, '/demo/messages', seed.csrfToken, {
      source_id: seed.sourceId,
      rule_id: seed.ruleId,
      recipient_ids: [seed.recipientId],
      text: `${title} por R$ ${price},00`,
    })

    const card = page.locator('.match-card', { hasText: title })
    await expect(card).toBeVisible()
    await expect(card.getByText('Alvo atingido')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

    await page.screenshot({ path: `test-results/feed-v2/${theme}-1440.png`, fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    const [scrollWidth, clientWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ])
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
    await page.screenshot({ path: `test-results/feed-v2/${theme}-390.png`, fullPage: true })
  })
}
