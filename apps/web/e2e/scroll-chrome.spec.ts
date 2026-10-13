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
  // S16-01: the disc's centre tracks the left rail's own column — at this
  // point the rail hasn't collapsed yet (scrolling past it is a separate,
  // later trigger), so its column is still the wide, open one; the disc
  // still centres on it rather than a fixed inset.
  const centerXOf = (b: { x: number; width: number }) => b.x + b.width / 2
  const centerOf = (b: { y: number; height: number }) => b.y + b.height / 2
  const grid = page.locator('.feed-page__grid')
  const leftRail = page.locator('.feed-rail')
  const sideRail = page.locator('.feed-page__side-rail')
  const list = page.locator('.feed-page__list')
  await expect(grid).toHaveAttribute('data-left-rail', 'open')
  expect(Math.abs(centerXOf(capsule) - centerXOf(await box(leftRail)))).toBeLessThan(2)
  // S15-04: disco, controles e botão de tema na mesma linha central da faixa.
  const toggle = await box(page.locator('.theme-toggle__button'))
  expect(Math.abs(centerOf(capsule) - centerOf(actions))).toBeLessThan(2)
  expect(Math.abs(centerOf(toggle) - centerOf(actions))).toBeLessThan(2)
  // S16-01: the theme button's centre tracks the right rail's own column too.
  expect(Math.abs(centerXOf(toggle) - centerXOf(await box(sideRail)))).toBeLessThan(2)
  // S16-01: the toolbar's right edge sits on the cards column's own right edge.
  const listBoxOpen = await box(list)
  expect(Math.abs(actions.x + actions.width - (listBoxOpen.x + listBoxOpen.width))).toBeLessThan(2)
  // Recolhida, só um círculo: o mascote não desenha disco próprio.
  await expect(page.locator('.nav-mascot__tint')).toHaveCSS('opacity', '0')
  const mascot = await box(page.locator('.nav-mascot'))
  expect(mascot.x).toBeGreaterThanOrEqual(capsule.x)
  expect(mascot.x + mascot.width).toBeLessThanOrEqual(capsule.x + capsule.width + 1)
  // S16-01: "Feed ao vivo · N matches" shows up only once compact, next to
  // the disc — and the dissolve band repaints the real page background,
  // never a dark overlay of its own.
  const contextCapsule = page.locator('.feed-page__context-capsule')
  await expect(contextCapsule).toBeVisible()
  await expect(contextCapsule).toContainText('Feed ao vivo')
  await expect(contextCapsule).toContainText('matches')
  const [scrimBg, bodyBg] = await Promise.all([
    page.locator('.feed-chrome-scrim').evaluate((el) => getComputedStyle(el).backgroundColor),
    page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor),
  ])
  expect(scrimBg).toBe(bodyBg)

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

  // S16-01 "Pronto quando": once both rails are also collapsed (the actual
  // "barra recolhida em grade" of the comp — 64·1fr·64), the disc, the
  // theme button and the toolbar's right edge line up with those exact
  // columns, within 2px.
  const collapsedCapsule = await box(page.locator('.nav-capsule'))
  const collapsedLeftRail = await box(leftRail)
  expect(Math.abs(centerXOf(collapsedCapsule) - centerXOf(collapsedLeftRail))).toBeLessThan(2)
  const collapsedToggle = await box(page.locator('.theme-toggle__button'))
  const collapsedSideRail = await box(sideRail)
  expect(Math.abs(centerXOf(collapsedToggle) - centerXOf(collapsedSideRail))).toBeLessThan(2)
  const collapsedActions = await box(page.locator('.feed-page__header-actions'))
  const collapsedList = await box(list)
  expect(Math.abs(collapsedActions.x + collapsedActions.width - (collapsedList.x + collapsedList.width))).toBeLessThan(2)

  // O mascote abre e fecha a navbar no modo compacto.
  await page.getByRole('button', { name: 'Expandir navegação' }).click()
  await page.mouse.move(720, 600)
  await settle(page)
  expect((await box(page.locator('.nav-capsule'))).width).toBeGreaterThan(500)
  await expect(page.getByRole('link', { name: 'Regras' })).toBeVisible()
  // S16-01: the context capsule never sits under the opened navbar.
  await expect(contextCapsule).toHaveCSS('opacity', '0')
  await page.getByRole('button', { name: 'Recolher navegação' }).click()
  await page.mouse.move(720, 600)
  await settle(page)
  expect((await box(page.locator('.nav-capsule'))).width).toBeLessThan(70)
  await expect(contextCapsule).toHaveCSS('opacity', '1')

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

  // De volta ao topo: tudo volta ao layout normal. S15-08/S16-02: Digest se
  // desdobra com o MESMO tamanho em todo frame visível (antes ficava mais
  // largo durante a mola e re-quebrava o texto ao fim dela) — "Resumo de
  // hoje" saiu do design (S16-02), só "Digest diário" segue em
  // `.feed-side__more`.
  await page.evaluate(() => {
    const w = window as unknown as { __sizes: string[] }
    w.__sizes = []
    const t0 = performance.now()
    const tick = (now: number) => {
      const more = document.querySelector('.feed-side__more') as HTMLElement
      if (Number(getComputedStyle(more).opacity) > 0.05) {
        const r = document.querySelector('#feed-side-digest')?.getBoundingClientRect()
        if (r) w.__sizes.push(`#feed-side-digest ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
      if (now - t0 < 1200) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(1300)
  const sizes = await page.evaluate(() => (window as unknown as { __sizes: string[] }).__sizes)
  const distinctDigestSizes = new Set(sizes.filter((size) => size.startsWith('#feed-side-digest')))
  expect([...distinctDigestSizes], '#feed-side-digest: um tamanho só durante a mola').toHaveLength(1)
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
