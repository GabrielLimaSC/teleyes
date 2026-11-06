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
 *
 * S12-04: runs in either theme. `MOTION_THEME=dark` renders the dark theme
 * (the OS colour scheme, with the preference on "Sistema") and suffixes the
 * evidence files with the theme; the default is the light theme, files unchanged.
 */
const DARK = process.env.MOTION_THEME === 'dark'
test.use({ colorScheme: DARK ? 'dark' : 'light' })
const SUFFIX = DARK ? '-dark' : ''

async function rafPumpWait(page: Page, totalMs: number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await page.waitForTimeout(totalMs / steps)
  }
}

test('mobile navigation drawer opens from the mascot (mid-transition capture)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const menu = page.locator('.nav-capsule__menu')
  const mascot = page.getByRole('button', { name: 'Expandir navegação' })
  const before = await menu.evaluate((el) => getComputedStyle(el).transform)

  await page.addStyleTag({
    content: '.nav-capsule__menu { transition-duration: 10000ms !important; }',
  })
  await mascot.click()
  await rafPumpWait(page, 200, 4)
  await page.screenshot({ path: '.impeccable/review/motion-nav-expansion-mid-flight' + SUFFIX + '.png' })
  const mid = await menu.evaluate((el) => getComputedStyle(el).transform)
  const midAnimState = await menu.evaluate((el) => el.getAnimations().map((a) => a.playState))

  expect(mid).not.toBe(before)
  expect(mid).not.toBe('matrix(1, 0, 0, 1, 0, 0)')
  expect(midAnimState.length).toBeGreaterThan(0)
  expect(midAnimState.every((state) => state === 'running')).toBe(true)
})

test('page change crossfades through intermediate frames without stalling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const feedHeading = page.getByRole('heading', { name: 'Ofertas ao vivo' })
  const saudeHeading = page.getByRole('heading', { name: 'Saúde' })

  // S25-M1: page changes run through the View Transitions API. A linear,
  // slowed copy lets the test compare equally-spaced frames of the incoming
  // page's layer without depending on the production easing or machine speed.
  await page.addStyleTag({
    content:
      '::view-transition-old(root), ::view-transition-new(root) { animation-duration: 1600ms !important; ' +
      'animation-timing-function: linear !important; }',
  })
  await page.getByRole('link', { name: 'Saúde' }).click()

  const layerOpacity = () =>
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity),
    )
  const opacities: number[] = []
  for (const frame of [1, 2, 3]) {
    await rafPumpWait(page, 260, 4)
    opacities.push(await layerOpacity())
    await page.screenshot({ path: `.impeccable/review/motion-page-transition-${frame}${SUFFIX}.png` })
  }

  expect(opacities).toHaveLength(3)
  expect(opacities.every(Number.isFinite)).toBe(true)
  expect(opacities[1]).toBeGreaterThan(opacities[0])
  expect(opacities[2]).toBeGreaterThan(opacities[1])
  expect(opacities[2]).toBeLessThan(1)
  // Navigation bars are named layers: they are not part of the crossfade.
  await expect(page.locator('.nav-capsule')).toHaveCSS('view-transition-name', 'teleyes-nav')
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
    ['Início', '/'],
    ['Ofertas', '/feed'],
    ['Regras', '/regras'],
    ['Grupos', '/fontes'],
    ['Histórico', '/historico'],
    ['Saúde', '/saude'],
  ] as const

  for (const [label, path] of routeSequence) {
    await page.getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`))
  }

  // Exercise interruption: each new click arrives before the 180ms fade can
  // finish. The live navigation must accept every real pointer click and
  // settle on the final requested route with no animation left hanging.
  for (const label of ['Início', 'Ofertas', 'Regras', 'Grupos', 'Histórico', 'Saúde']) {
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

  const button = page.locator('.regras-page__new-button')
  const box = await button.boundingBox()
  expect(box).not.toBeNull()

  // click near the right edge so the expanding fill is clearly off-center
  // and visibly still growing when captured
  await page.mouse.move(box!.x + box!.width - 10, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.screenshot({ path: '.impeccable/review/motion-button-fill-mid-expand' + SUFFIX + '.png' })
  await page.mouse.up()

  const fillWidth = await button.evaluate((el) => getComputedStyle(el, '::after').clipPath)
  expect(fillWidth).not.toBe('none')
})
