import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S15-01: cards compactos do Feed. Regressão da sobreposição: com
 * `height: 100%` + padding em content-box, cada card ficava 32-34px mais alto
 * que a própria célula do grid e pintava por cima do card de baixo.
 *
 * Nome começa com "match-" de propósito: feed.spec.ts espera o backend
 * compartilhado ainda vazio, então este spec precisa rodar depois dele.
 *
 * Real backend (`/demo/messages`), mesmo padrão de feedv2.spec.ts; tag e
 * preços aleatórios porque o backend de e2e é compartilhado pela rodada.
 */

function uniqueTag(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2, 8)}`
}

async function seedVariedCards(page: Page, tag: string): Promise<void> {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Fonte ${tag}`,
    telegram_chat_id: `chat-${tag}`,
  })
  const base = 3000 + Math.floor(Math.random() * 90_000)
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra ${tag}`,
    include_terms: tag,
    target_price_cents: base * 100,
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Dest ${tag}`,
    telegram_chat_id: `dest-${tag}`,
    allowlisted: true,
  })

  const texts = [
    `Processador ${tag} por R$ ${base - 50},00`,
    `Placa Mãe MSI Pro B840M-B, DDR5, Socket AMD AM5, Micro ATX, com título comprido de verdade ${tag} por R$ ${base + 400},00`,
    `Placa de vídeo ${tag} por R$ ${base + 900},00`,
    `Memória ${tag} por R$ ${base + 1300},00`,
    `Placa-Mãe Gigabyte B650M D3HP, AMD AM5, mATX, DDR5, com mais uma linha de descrição ${tag} por R$ ${base + 1700},00`,
  ]
  for (const text of texts) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text,
    })
  }
}

async function expectCardsInsideTheirCells(page: Page): Promise<void> {
  const cells = page.locator('.feed-page__card')
  const count = await cells.count()
  expect(count).toBe(5)
  for (let index = 0; index < count; index += 1) {
    const cell = await cells.nth(index).boundingBox()
    const card = await cells.nth(index).locator('.match-card').boundingBox()
    if (!cell || !card) throw new Error('bounding box missing')
    expect(card.y + card.height).toBeLessThanOrEqual(cell.y + cell.height + 1)
    expect(card.x + card.width).toBeLessThanOrEqual(cell.x + cell.width + 1)
  }
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`cards do Feed não se sobrepõem — ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const tag = uniqueTag(`layout-${viewport.name}`)
    await seedVariedCards(page, tag)

    await page.goto('/feed')
    await page.getByRole('button', { name: new RegExp(`Regra ${tag}`) }).click()
    await expect(page.locator('.feed-page__card')).toHaveCount(5)

    await expectCardsInsideTheirCells(page)

    // Ações e link da promoção continuam dentro do card, sem estourar a lateral.
    const firstCard = page.locator('.match-card').first()
    const cardBox = await firstCard.boundingBox()
    const linkBox = await firstCard.locator('.match-card__actions').boundingBox()
    if (!cardBox || !linkBox) throw new Error('bounding box missing')
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

    if (process.env.LAYOUT_SHOTS) {
      await page.locator('.feed-page__list').screenshot({ path: `${process.env.LAYOUT_SHOTS}/${viewport.name}.png` })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.locator('.feed-page__list').screenshot({ path: `${process.env.LAYOUT_SHOTS}/${viewport.name}-dark.png` })
    }
  })
}
