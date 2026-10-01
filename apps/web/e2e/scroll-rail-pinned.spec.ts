import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S15-05: regression for the `pinned` rail (S15-03/S15-04 compact chrome,
 * opened back up from its icon strip) clipping its own content. Two bugs,
 * same root cause — a hardcoded inner width that only accounted for the
 * spring animation, never for the classic scrollbar `overflow-y: auto`
 * draws once the rail is taller than the viewport:
 *  - `.feed-rail__full-inner` / `.feed-side__full-inner` sized their content
 *    at the rail's full 272/312px even though the scrollbar ate part of
 *    that width, running "Alvos de preço" cards and "Filtrar por regra"
 *    buttons off the right edge;
 *  - `.feed-rail__collapse` (the "Recolher painel" chevron) sat at a
 *    negative inset, past `.feed-rail__full`'s own `overflow: hidden` box.
 *
 * Needs a rail taller than the viewport (many rules/sources) and a real,
 * non-overlay scrollbar — forced here via `::-webkit-scrollbar` so this
 * reproduces in headless Chromium too, the same as Gabriel's macOS/Chrome
 * with "always show scrollbars". Real backend; tag keeps data isolated
 * (backend shared with other specs running in parallel).
 */

async function seedTallRails(page: Page): Promise<void> {
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  // 13 sources + 10 rules with a price target: enough "Alvos de preço" cards,
  // "Filtrar por regra" buttons and "Fontes" rows that the left rail is
  // taller than a 900px-tall viewport once it's `pinned`.
  const sources: { id: number }[] = []
  for (let index = 0; index < 13; index += 1) {
    sources.push(
      await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Fonte ${tag}-${index}`, telegram_chat_id: `c-${tag}-${index}` }),
    )
  }
  const rules: { id: number }[] = []
  for (let index = 0; index < 10; index += 1) {
    rules.push(
      await apiPost<{ id: number }>(page, '/rules', csrf, {
        name: `Alvo ${tag}-${index}`,
        include_terms: `termo${tag}${index}`,
        target_price_cents: 10000 + index * 500,
      }),
    )
  }
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest ${tag}`,
    telegram_chat_id: `d-${tag}`,
    allowlisted: true,
  })
  // Plenty of matches too: scrolling the left rail fully out of view (to
  // collapse it into its icon strip, as a real visit would) needs the feed
  // column — the grid's other track — at least as tall as the rail itself,
  // or there's nowhere left to scroll to.
  for (let index = 0; index < 40; index += 1) {
    await apiPost(page, '/demo/messages', csrf, {
      source_id: sources[0].id,
      rule_id: rules[0].id,
      recipient_ids: [recipient.id],
      text: `Produto ${index} termo${tag}0 por R$ ${1000 + index * 17},00`,
    })
  }
}

function forceClassicScrollbar(page: Page) {
  // Whether headless Chromium draws a room-taking (vs. overlay, zero-width)
  // scrollbar depends on the OS/environment it runs in — `::-webkit-scrollbar`
  // only skins one that already draws as classic, it can't switch overlay to
  // classic by itself. `scrollbar-gutter: stable`, forced here independently
  // of FeedPage.css (so it applies the same whether or not the fix under
  // test defines its own), reserves that room deterministically — the same
  // real effect as Gabriel's macOS "always show scrollbars" setting.
  return page.addStyleTag({
    content: `
      * { scrollbar-width: auto !important; }
      .feed-rail, .feed-page__side-rail { scrollbar-gutter: stable !important; }
      ::-webkit-scrollbar { width: 15px !important; height: 15px !important; }
      ::-webkit-scrollbar-thumb { background: #888; }
    `,
  })
}

interface ClipRect {
  top: number
  right: number
  scrollbarWidth: number
}

/** The two boxes that actually clip a pinned rail's content:
 *  - the aside itself (`.feed-rail` / `.feed-page__side-rail`), the scroll
 *    container — its scrollport excludes the scrollbar's own width;
 *  - the morphing glass box (`.feed-morph`: the left aside itself, or
 *    "Resumo" inside the right rail — S15-07), which clips while it springs
 *    and while folded, no scrolling of its own.
 * `getBoundingClientRect` ignores ancestor clipping, so this measures both
 * boundaries and intersects them — the actual visible box content must stay
 * inside of. */
async function clipRectOf(page: Page, asideSelector: string): Promise<ClipRect> {
  return page.evaluate((selector) => {
    const aside = document.querySelector(selector) as HTMLElement
    const full = (aside.matches('.feed-morph') ? aside : aside.querySelector('.feed-morph')) as HTMLElement
    const asideRect = aside.getBoundingClientRect()
    const fullRect = full.getBoundingClientRect()
    const scrollbarWidth = aside.offsetWidth - aside.clientWidth
    return {
      top: Math.max(asideRect.top, fullRect.top),
      right: Math.min(asideRect.right - scrollbarWidth, fullRect.right),
      scrollbarWidth,
    }
  }, asideSelector)
}

async function assertInside(locator: Locator, clip: ClipRect, label: string) {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${label}: bounding box missing`)
  expect(box.y, `${label}: cortado em cima`).toBeGreaterThanOrEqual(clip.top - 0.5)
  expect(box.x + box.width, `${label}: cortado à direita`).toBeLessThanOrEqual(clip.right + 0.5)
}

async function settle(page: Page) {
  await page.waitForTimeout(900)
}

test('trilho esquerdo pinned: cards, botões e o chevron ficam inteiros dentro do trilho', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedTallRails(page)
  await page.goto('/feed')
  await expect(page.locator('.feed-page__grid')).toBeVisible()
  await forceClassicScrollbar(page)

  // Compact chrome, then fold the left rail into its icon strip (scrolled
  // past it) before reopening it "pinned" from one of its icons.
  await page.mouse.move(720, 600)
  await page.mouse.wheel(0, 200)
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'compact')
  // +300 clears the `band` the fold threshold subtracts (FeedPage.tsx) plus
  // any rounding — the rail is deliberately seeded much taller than the
  // viewport, so overshooting past its bottom is harmless.
  await page.evaluate(() =>
    window.scrollBy(0, document.querySelector('.feed-rail')!.getBoundingClientRect().bottom + 300),
  )
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-left-rail', 'collapsed')
  await settle(page)

  await page.getByRole('button', { name: 'Alvos de preço', exact: true }).click()
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-left-rail', 'pinned')
  await settle(page)

  const clip = await clipRectOf(page, '.feed-rail')
  // Confirms the test actually reproduces the reported setup: without a
  // classic scrollbar taking real room there is nothing to clip.
  expect(clip.scrollbarWidth, 'setup: nenhuma barra de rolagem clássica medida').toBeGreaterThan(5)

  const targets = page.locator('.feed-target')
  const targetCount = await targets.count()
  expect(targetCount).toBeGreaterThan(0)
  for (let index = 0; index < targetCount; index += 1) {
    await assertInside(targets.nth(index), clip, `feed-target #${index}`)
  }
  await assertInside(page.locator('.feed-rail__collapse'), clip, 'chevron "Recolher painel"')

  // Scroll the rail itself down to the "Filtrar por regra" section — the
  // other content the report calls out as cut on the right.
  await page.evaluate(() => {
    const section = document.getElementById('feed-rail-filter')!
    document.querySelector('.feed-rail')!.scrollTo({ top: section.offsetTop, behavior: 'instant' as ScrollBehavior })
  })
  const ruleButtons = page.locator('.feed-rail__rule')
  const ruleCount = await ruleButtons.count()
  expect(ruleCount).toBeGreaterThan(0)
  for (let index = 0; index < ruleCount; index += 1) {
    const box = await ruleButtons.nth(index).boundingBox()
    if (!box) continue
    // Only the ones actually inside the rail's viewport band (scrolled to)
    // matter — ones further down are legitimately off-screen, not clipped.
    if (box.y < clip.top || box.y > clip.top + 900) continue
    await assertInside(ruleButtons.nth(index), clip, `feed-rail__rule #${index}`)
  }
})

test('trilho direito pinned: os cards de resumo e o chevron ficam inteiros dentro do trilho', async ({ page }) => {
  // A shorter viewport is enough to push the right rail (Resumo + Resumo de
  // hoje, no seeding needed) past what's left of the screen once pinned.
  await page.setViewportSize({ width: 1440, height: 560 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')
  await expect(page.locator('.feed-page__grid')).toBeVisible()
  await forceClassicScrollbar(page)

  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, 200)
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'compact')
  await page.evaluate(() =>
    window.scrollBy(0, document.querySelector('.feed-page__side-rail')!.getBoundingClientRect().bottom + 300),
  )
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-right-rail', 'collapsed')
  await settle(page)

  await page.getByRole('button', { name: 'Resumo', exact: true }).click()
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-right-rail', 'pinned')
  await settle(page)

  const clip = await clipRectOf(page, '.feed-page__side-rail')
  expect(clip.scrollbarWidth, 'setup: nenhuma barra de rolagem clássica medida').toBeGreaterThan(5)

  const tiles = page.locator('.feed-summary__tile')
  const tileCount = await tiles.count()
  expect(tileCount).toBeGreaterThan(0)
  for (let index = 0; index < tileCount; index += 1) {
    await assertInside(tiles.nth(index), clip, `feed-summary__tile #${index}`)
  }
  await assertInside(page.locator('.feed-rail__collapse'), clip, 'chevron "Recolher painel" (direito)')
})
