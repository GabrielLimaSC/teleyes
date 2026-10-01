import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut } from './helpers'

/**
 * S16-03: a barra de ações do MatchCard no novo design — nunca quebra em
 * duas linhas (card largo ou estreito), o menu "⋯" é acessível, e "Corrigir"/
 * "Corrigir preço" substitui "Definir alvo" quando o preço não foi
 * identificado. Real backend (`/demo/messages`), mesmo padrão de
 * feedv2.spec.ts/product-panel-actions.spec.ts — tag aleatória porque o
 * backend de e2e é compartilhado pela rodada.
 *
 * Nome começa com "match-" de propósito (mesma razão de
 * match-card-layout.spec.ts): feed.spec.ts espera o backend compartilhado
 * ainda vazio, então este spec precisa rodar depois dele.
 */

let groupingDisabled = false

interface Seed {
  csrfToken: string
  ruleId: number
  title: string
  productKey: string
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'same-origin' })
    return (await response.json()) as unknown
  }, path) as Promise<T>
}

/** A real product_key (S14-01's "brand + model" fingerprint) so "Criar regra
 * disso"/"Silenciar 7 dias"/"Corrigir" all have somewhere to render — same
 * title shape product-panel-actions.spec.ts's own seed already relies on. */
async function seedProduct(
  page: Page,
  tag: string,
  titleBase: string,
  priceText: string | null,
  link = 'https://t.me/c/123456/777',
): Promise<Seed> {
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
  const text = priceText === null ? `${title} fora de estoque, sem preço no anúncio` : `${title} por R$ ${priceText}`
  const demo = await apiPost<{ match_id: number }>(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text,
    link,
  })
  const matches = await apiGet<Array<{ id: number; product_key: string | null }>>(page, '/matches')
  const productKey = matches.find((match) => match.id === demo.match_id)?.product_key ?? null
  expect(productKey, 'seeded message must carry a real product_key').not.toBeNull()
  return { csrfToken, ruleId: rule.id, title, productKey: productKey as string }
}

/** scroll-chrome.spec.ts's own trick: enough cards that the page actually
 * has somewhere to scroll to — in an isolated run of just this file the
 * shared backend may still be empty, and a one-card Feed never scrolls at
 * all (nothing for the mouse wheel to move). */
async function seedFiller(page: Page, csrfToken: string, tag: string, count: number): Promise<void> {
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Loja Filler ${tag}`,
    telegram_chat_id: `filler-${tag}`,
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Dest Filler ${tag}`,
    telegram_chat_id: `filler-dest-${tag}`,
    allowlisted: true,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra Filler ${tag}`,
    include_terms: `filler${tag}`,
  })
  for (let index = 0; index < count; index += 1) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `Enchimento ${index} filler${tag} por R$ ${1000 + index * 17},00`,
    })
  }
}

/** Scrolls the Feed into its compact chrome AND past both rails (scroll-
 * chrome.spec.ts's own two-step trick) — `data-chrome="compact"` alone only
 * shrinks the top bar; the grid itself only springs its rail columns down to
 * a 64px strip once `data-left-rail`/`data-right-rail` turn "collapsed",
 * which needs scrolling past each rail's own bottom edge, not just past the
 * 96px compact threshold. That 64·1fr·64 grid is the only way the Feed's own
 * 2-column grid gives a card ≥480px, the comp's wide-card breakpoint. */
async function scrollIntoWideCards(page: Page): Promise<void> {
  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, 200)
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'compact')

  await page.evaluate(() => {
    const bottoms = ['.feed-rail', '.feed-page__side-rail'].map(
      (selector) => document.querySelector(selector)!.getBoundingClientRect().bottom,
    )
    window.scrollBy(0, Math.max(...bottoms))
  })
  const grid = page.locator('.feed-page__grid')
  await expect(grid).toHaveAttribute('data-left-rail', 'collapsed')
  await expect(grid).toHaveAttribute('data-right-rail', 'collapsed')
  // The rails' own spring (scroll-chrome.spec.ts's `settle`) needs to
  // actually finish before a card's measured width reflects the wide
  // layout.
  await page.waitForTimeout(900)
}

test.describe('MatchCard — ações em uma linha (S16-03 01/05)', () => {
  test('a barra de ações nunca quebra em duas linhas — card estreito (topo) e largo (rolado)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const seed = await seedProduct(page, 'linha', 'Placa de vídeo Ações Linha', '3.299')
    await seedFiller(page, seed.csrfToken, 'linha', 16)

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    await expect(card).toBeVisible()

    // Topo, rails expandidos: card estreito (<480px de contêiner). Dá um
    // instante pro ResizeObserver do card assentar antes de medir — a
    // própria troca de layout é assíncrona.
    await expect(card.getByRole('link', { name: 'Abrir promoção' })).not.toHaveText(/Abrir promoção/)
    const narrowBox = await card.locator('.match-card__actions').boundingBox()
    if (!narrowBox) throw new Error('bounding box missing')
    // Uma única linha: a altura do maior botão (34px, destaque Aurora Glow
    // do 1º match de um produto) mais o padding-top/border-top próprios da
    // barra (12 + 1) — bem longe da altura dobrada de duas linhas quebradas
    // (≥ 34+34+8 de gap).
    expect(narrowBox.height).toBeLessThan(55)

    await scrollIntoWideCards(page)
    const wideCard = page.locator('.match-card', { hasText: seed.title })
    await expect(wideCard).toBeVisible()
    await expect(wideCard.getByRole('link', { name: 'Abrir promoção' })).toHaveText(/Abrir promoção/)
    const wideBox = await wideCard.locator('.match-card__actions').boundingBox()
    if (!wideBox) throw new Error('bounding box missing')
    expect(wideBox.height).toBeLessThan(55)
  })

  test('card largo: "Silenciar" e "Abrir promoção" por extenso ficam na barra, fora do menu', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const seed = await seedProduct(page, 'largo', 'Placa de vídeo Ações Largo', '2.899')
    await seedFiller(page, seed.csrfToken, 'largo', 16)

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    // Precisa do feed já renderizado (altura real de scroll) antes de rolar
    // — do contrário o wheel não encontra o que rolar.
    await expect(card).toBeVisible()
    await scrollIntoWideCards(page)

    await expect(card.getByRole('button', { name: 'Silenciar 7 dias' })).toBeVisible()
    await expect(card.getByRole('link', { name: 'Abrir promoção' })).toHaveText(/Abrir promoção/)
    // "Criar regra disso" stays behind "⋯" even on a wide card.
    await expect(card.getByRole('button', { name: 'Criar regra disso' })).not.toBeVisible()
    await card.getByRole('button', { name: 'Mais ações' }).click()
    await expect(card.getByRole('menuitem', { name: 'Criar regra disso' })).toBeVisible()
    // Silenciar is already a standalone button here — the menu doesn't
    // duplicate it.
    await expect(card.getByRole('menuitem', { name: /Silenciar/ })).toHaveCount(0)
  })

  test('card estreito: "Silenciar" sai da barra e vira item do menu; "Abrir promoção" vira ícone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const seed = await seedProduct(page, 'estreito', 'Placa de vídeo Ações Estreito', '2.599')

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    await expect(card).toBeVisible()

    await expect(card.getByRole('button', { name: 'Silenciar 7 dias' })).not.toBeVisible()
    const promoLink = card.getByRole('link', { name: 'Abrir promoção' })
    await expect(promoLink).toBeVisible()
    // Icon-only: no visible "Abrir promoção" text node left in the link.
    await expect(promoLink).not.toHaveText(/Abrir promoção/)

    await card.getByRole('button', { name: 'Mais ações' }).click()
    await expect(card.getByRole('menuitem', { name: 'Silenciar 7 dias' })).toBeVisible()
    await expect(card.getByRole('menuitem', { name: 'Criar regra disso' })).toBeVisible()
  })
})

test.describe('MatchCard — menu "⋯" acessível (S16-03 05)', () => {
  test('abre com aria-haspopup/aria-expanded corretos, fecha com Esc e devolve o foco ao botão', async ({ page }) => {
    const seed = await seedProduct(page, 'menu-esc', 'Placa de vídeo Ações MenuEsc', '1.899')

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    await expect(card).toBeVisible()

    const trigger = card.getByRole('button', { name: 'Mais ações' })
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByRole('menu')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(card.getByRole('menu')).not.toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()
  })

  test('fecha ao clicar fora, e ao escolher um item (foco volta ao botão)', async ({ page }) => {
    const seed = await seedProduct(page, 'menu-fora', 'Placa de vídeo Ações MenuFora', '1.799')

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    await expect(card).toBeVisible()
    const trigger = card.getByRole('button', { name: 'Mais ações' })

    await trigger.click()
    await expect(card.getByRole('menu')).toBeVisible()
    await page.getByRole('heading', { name: 'Feed ao vivo' }).click()
    await expect(card.getByRole('menu')).not.toBeVisible()

    await trigger.click()
    await expect(card.getByRole('menu')).toBeVisible()
    await card.getByRole('menuitem', { name: 'Criar regra disso' }).click()
    await expect(page).toHaveURL(/\/regras\?produto=/)
  })
})

test.describe('MatchCard — preço ausente (S16-03 02)', () => {
  test('mostra "Corrigir"/"Corrigir preço" no lugar de "Definir alvo" quando o preço não foi identificado', async ({
    page,
  }) => {
    const seed = await seedProduct(page, 'sem-preco-acoes', 'Placa de vídeo Ações SemPreco', null)

    await page.goto('/feed')
    const card = page.locator('.match-card', { hasText: seed.title })
    await expect(card).toBeVisible()

    await expect(card.getByRole('button', { name: 'Definir alvo' })).not.toBeVisible()
    await expect(card.getByRole('button', { name: /^Corrigir/ })).toBeVisible()
  })
})
