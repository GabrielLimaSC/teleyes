import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin } from './helpers'

/**
 * Static full-page screenshots (responsive.spec.ts) can't show the app's
 * three motion devices — they're only visible mid-transition. This captures
 * them mid-flight as evidence for design review, and doubles as a smoke
 * check that each one actually fires (a transition that never starts leaves
 * two identical frames, which the assertions below would fail on).
 *
 * The nav expansion and page fade use front-loaded ease-out curves, so fixed-ms
 * waits at native speed are too timing-sensitive across machines. Each is
 * slowed down first, then sampled across multiple rendered frames.
 *
 * A plain `waitForTimeout` before the screenshot was not reliable even at a
 * slowed duration: a single big wait let the animation's rendered state lag
 * behind wall-clock time (headless Chromium doesn't necessarily keep pumping
 * animation frames absent something requesting one), so the capture could
 * land later in the curve than the wait implied. Explicitly pumping a few
 * rAF ticks across the wait keeps the animation's state honest.
 */
async function rafPumpWait(page: Page, totalMs: number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await page.waitForTimeout(totalMs / steps)
  }
}

test('nav capsule expands sideways from the mascot (mid-transition capture)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const glass = page.locator('.nav-capsule__glass')
  const mascot = page.getByRole('button', { name: 'Expandir navegação' })
  const before = await glass.evaluate((el) => getComputedStyle(el).transform)

  await page.addStyleTag({
    content: '.nav-capsule__glass { transition-duration: 10000ms !important; }',
  })
  await mascot.click()
  await rafPumpWait(page, 200, 4)
  await page.screenshot({ path: '.impeccable/review/motion-nav-expansion-mid-flight.png' })
  const mid = await glass.evaluate((el) => getComputedStyle(el).transform)
  const midAnimState = await glass.evaluate((el) => el.getAnimations().map((a) => a.playState))

  expect(mid).not.toBe(before)
  expect(mid).not.toBe('matrix(1, 0, 0, 1, 0, 0)')
  expect(midAnimState.length).toBeGreaterThan(0)
  expect(midAnimState.every((state) => state === 'running')).toBe(true)
})

test('page fade advances through intermediate frames without stalling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const feedHeading = page.getByRole('heading', { name: 'Feed ao vivo' })
  const saudeHeading = page.getByRole('heading', { name: 'Saúde' })

  await page.addStyleTag({
    // A linear, slowed copy lets this test compare equally-spaced visual
    // frames without depending on the production easing or machine speed.
    content:
      'main { animation-duration: 1600ms !important; ' +
      'animation-timing-function: linear !important; }',
  })
  await page.locator('.nav-mascot').hover()
  await page.getByRole('link', { name: 'Saúde' }).click()

  const opacities: number[] = []
  for (const frame of [1, 2, 3]) {
    await rafPumpWait(page, 260, 4)
    opacities.push(
      await page
        .locator('main')
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    )
    await page.screenshot({ path: `.impeccable/review/motion-page-transition-${frame}.png` })
  }

  const fadeStates = await page
    .locator('main')
    .evaluate((element) => element.getAnimations().map((animation) => animation.playState))
  expect(fadeStates).toContain('running')
  expect(opacities).toHaveLength(3)
  expect(opacities.every(Number.isFinite)).toBe(true)
  expect(opacities[1]).toBeGreaterThan(opacities[0])
  expect(opacities[2]).toBeGreaterThan(opacities[1])
  expect(opacities[2]).toBeLessThan(1)
  await expect(feedHeading).not.toBeVisible()
  await expect(saudeHeading).toBeVisible()
})

test('all tabs remain responsive during rapid page-fade navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  // Remount AuthProvider so protected-route clicks see the authenticated
  // session established through the API helper.
  await page.goto('/feed')

  const routeSequence = [
    ['Login', '/'],
    ['Feed', '/feed'],
    ['Regras', '/regras'],
    ['Fontes', '/fontes'],
    ['Histórico', '/historico'],
    ['Saúde', '/saude'],
  ] as const

  await page.locator('.nav-mascot').hover()
  for (const [label, path] of routeSequence) {
    await page.getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`))
  }

  // Exercise interruption: each new click arrives before the 180ms fade can
  // finish. The live navigation must accept every real pointer click and
  // settle on the final requested route with no animation left hanging.
  for (const label of ['Login', 'Feed', 'Regras', 'Fontes', 'Histórico', 'Saúde']) {
    await page.getByRole('link', { name: label }).click()
    await page.waitForTimeout(35)
  }

  await expect(page).toHaveURL(/\/saude$/)
  await expect(page.getByRole('heading', { name: 'Saúde' })).toBeVisible()
  await page.waitForTimeout(500)
  const runningTransitions = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
  )
  expect(runningTransitions).toBe(0)
})

test('primary button fill expands from the click point', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  const button = page.locator('.crud-page__new-button').first()
  const box = await button.boundingBox()
  expect(box).not.toBeNull()

  // click near the right edge so the expanding fill is clearly off-center
  // and visibly still growing when captured
  await page.mouse.move(box!.x + box!.width - 10, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.screenshot({ path: '.impeccable/review/motion-button-fill-mid-expand.png' })
  await page.mouse.up()

  const fillWidth = await button.evaluate((el) => getComputedStyle(el, '::after').clipPath)
  expect(fillWidth).not.toBe('none')
})
