import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S15-03: modo compacto do Feed ao rolar (chrome/scrollChrome.ts). Garante o
 * contrato, não os pixels da animação: entra e sai com o scroll, nada fixo
 * fica por cima dos cards, e o trilho aberto no modo compacto empurra o feed
 * em vez de cobri-lo. Real backend; tag aleatória (backend compartilhado).
 */

async function seedFeed(page: Page): Promise<void> {
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Fonte ${tag}`, telegram_chat_id: `c-${tag}` })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest ${tag}`,
    telegram_chat_id: `d-${tag}`,
    allowlisted: true,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrf, { name: `Chrome ${tag}`, include_terms: `chrome${tag}` })
  for (let index = 0; index < 14; index += 1) {
    await apiPost(page, '/demo/messages', csrf, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `Produto ${index} chrome${tag} por R$ ${1000 + index * 17},00`,
    })
  }
}

async function box(locator: Locator) {
  const result = await locator.boundingBox()
  if (!result) throw new Error('bounding box missing')
  return result
}

async function settle(page: Page) {
  // The spring is 680ms; wait until nothing is transitioning anymore.
  await page.waitForTimeout(900)
}

test('o Feed entra e sai do modo compacto com o scroll, sem nada fixo sobre os cards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedFeed(page)
  await page.goto('/feed')
  await expect(page.locator('.match-card').first()).toBeVisible()
  const html = page.locator('html')

  await expect(html).toHaveAttribute('data-chrome', 'rest')
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()

  await page.mouse.move(720, 600)
  await page.mouse.wheel(0, 200)
  await expect(html).toHaveAttribute('data-chrome', 'compact')
  await settle(page)

  // Título sumiu; controles no topo, dentro da faixa; navbar virou o disco.
  await expect(page.locator('.feed-page__title')).toHaveCSS('opacity', '0')
  const band = 84
  const actions = await box(page.locator('.feed-page__header-actions'))
  expect(actions.y + actions.height).toBeLessThanOrEqual(band)
  const capsule = await box(page.locator('.nav-capsule'))
  expect(capsule.width).toBeLessThan(70)
  expect(capsule.x).toBeLessThan(40)
  // S15-04: disco, controles e botão de tema na mesma linha central da faixa.
  const centerOf = (b: { y: number; height: number }) => b.y + b.height / 2
  const toggle = await box(page.locator('.theme-toggle__button'))
  expect(Math.abs(centerOf(capsule) - centerOf(actions))).toBeLessThan(2)
  expect(Math.abs(centerOf(toggle) - centerOf(actions))).toBeLessThan(2)
  // Recolhida, só um círculo: o mascote não desenha disco próprio.
  await expect(page.locator('.nav-mascot__tint')).toHaveCSS('opacity', '0')
  const mascot = await box(page.locator('.nav-mascot'))
  expect(mascot.x).toBeGreaterThanOrEqual(capsule.x)
  expect(mascot.x + mascot.width).toBeLessThanOrEqual(capsule.x + capsule.width + 1)

  // Um trilho ainda na tela continua aberto (nunca some debaixo do ponteiro)…
  const grid = page.locator('.feed-page__grid')
  const leftRail = page.locator('.feed-rail')
  const list = page.locator('.feed-page__list')
  await expect(grid).toHaveAttribute('data-left-rail', 'open')

  // …e só vira coluna de ícones depois que o scroll passa por ele: grudada
  // abaixo da faixa, fora da coluna dos cards.
  await page.evaluate(() => {
    const bottoms = ['.feed-rail', '.feed-page__side-rail'].map(
      (selector) => document.querySelector(selector)!.getBoundingClientRect().bottom,
    )
    window.scrollBy(0, Math.max(...bottoms))
  })
  await expect(grid).toHaveAttribute('data-left-rail', 'collapsed')
  await expect(grid).toHaveAttribute('data-right-rail', 'collapsed')
  await settle(page)
  const railBox = await box(leftRail)
  expect(railBox.width).toBeLessThan(80)
  expect(railBox.y).toBeGreaterThanOrEqual(band)
  expect(railBox.x + railBox.width).toBeLessThanOrEqual((await box(list)).x)

  // O mascote abre e fecha a navbar no modo compacto.
  await page.getByRole('button', { name: 'Expandir navegação' }).click()
  await page.mouse.move(720, 600)
  await settle(page)
  expect((await box(page.locator('.nav-capsule'))).width).toBeGreaterThan(500)
  await expect(page.getByRole('link', { name: 'Regras' })).toBeVisible()
  await page.getByRole('button', { name: 'Recolher navegação' }).click()
  await page.mouse.move(720, 600)
  await settle(page)
  expect((await box(page.locator('.nav-capsule'))).width).toBeLessThan(70)

  // Abrir um trilho no modo compacto empurra o feed — nunca por cima.
  await page.getByRole('button', { name: 'Filtrar por regra', exact: true }).click()
  await settle(page)
  const openRail = await box(leftRail)
  expect(openRail.width).toBeGreaterThan(250)
  expect(openRail.x + openRail.width).toBeLessThanOrEqual((await box(list)).x)
  await expect(page.getByRole('button', { name: 'Todas as regras' })).toBeVisible()
  await page.getByRole('button', { name: 'Recolher painel' }).first().click()
  await settle(page)
  expect((await box(leftRail)).width).toBeLessThan(80)

  // De volta ao topo: tudo volta ao layout normal.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(html).toHaveAttribute('data-chrome', 'rest')
  await settle(page)
  await expect(page.locator('.feed-page__title')).toHaveCSS('opacity', '1')
  expect((await box(leftRail)).width).toBeGreaterThan(250)
  expect((await box(page.locator('.nav-capsule'))).width).toBeGreaterThan(500)
})

test('fora do Feed e em tela estreita não há modo compacto', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await seedFeed(page)
  await page.goto('/feed')
  await expect(page.locator('.match-card').first()).toBeVisible()
  await page.mouse.wheel(0, 700)
  await page.waitForTimeout(300)
  await expect(page.locator('html')).not.toHaveAttribute('data-chrome', /.*/)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/regras')
  await expect(page.getByRole('heading', { name: 'Regras' })).toBeVisible()
  await expect(page.locator('html')).not.toHaveAttribute('data-chrome', /.*/)
})
