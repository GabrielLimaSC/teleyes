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
 * Both transitions use an aggressively front-loaded ease-out curve, so their
 * entire visible travel completes within the first few percent of their real
 * duration (native-speed probing measured the nav pill fully settling by
 * ~30ms of its nominal 320ms). A fixed-ms wait at native speed is too
 * timing-sensitive to be reliable across machines, so each transition is
 * slowed down first (transition-duration override), then captured after a
 * wait tuned to land at the same fraction of the curve that was confirmed
 * (by reading the actual screenshots, not just measuring box coordinates) to
 * look genuinely mid-flight.
 *
 * A plain `waitForTimeout` before the screenshot was not reliable even at a
 * slowed duration: a single big wait let the animation's rendered state lag
 * behind wall-clock time (headless Chromium doesn't necessarily keep pumping
 * animation frames absent something requesting one), so the capture could
 * land later in the curve than the wait implied — including, once, exactly
 * on the moment the page-transition's diagonal boundary crossed the heading
 * text, producing a jagged glyph-level cut that looked like a rendering bug.
 * Explicitly pumping a few rAF ticks across the wait keeps the animation's
 * state honest.
 */
async function rafPumpWait(page: Page, totalMs: number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await page.waitForTimeout(totalMs / steps)
  }
}

test('nav pill slides between tabs (mid-transition capture)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const pill = page.locator('.nav-pill')
  const regrasTab = page.getByRole('link', { name: 'Regras' })
  const before = await pill.boundingBox()
  // the tab link itself is never animated, so its box is always an accurate
  // read of the pill's true destination — comparing against it (rather than
  // re-measuring the pill after trying to force its slowed transition to
  // finish, which does not reliably snap mid-flight) avoids a race entirely
  const target = await regrasTab.boundingBox()

  await page.addStyleTag({
    // The page-transition wipe otherwise also fires on this same click (real
    // 420ms, unrelated to what this test is evidencing) and visibly competes
    // with the pill for attention in the capture — disabled here for root
    // only, so it doesn't touch the pill's own independently-tracked
    // view-transition-name group (NavCapsule.css). Slowing .nav-pill's own
    // transition is belt-and-suspenders for the non-view-transition fallback
    // path (reduced motion, no API support); the visible motion during an
    // active transition is actually driven by that named group's own timing.
    content:
      '.nav-pill { transition-duration: 10000ms !important; } ' +
      '::view-transition-old(root), ::view-transition-new(root) { animation: none !important; }',
  })
  await regrasTab.click()
  await rafPumpWait(page, 200, 4)
  await page.screenshot({ path: '.impeccable/review/motion-nav-pill-mid-slide.png' })
  const mid = await pill.boundingBox()
  const midAnimState = await pill.evaluate((el) => el.getAnimations().map((a) => a.playState))

  expect(before).not.toBeNull()
  expect(target).not.toBeNull()
  expect(mid).not.toBeNull()
  // the pill actually moved (not a snap) — its start position differs from
  // its destination at least on one axis
  expect(before!.x).not.toBe(target!.x)
  // and the capture really is mid-flight: still animating at capture time,
  // not a settled frame that merely differs by sub-pixel rounding (the
  // earlier version of this test byte-identically caught the pre-click
  // frame twice — a numeric-only check on the boxes let that slip through)
  expect(midAnimState.length).toBeGreaterThan(0)
  expect(midAnimState.every((state) => state === 'running')).toBe(true)
  // and hasn't already arrived at its destination
  expect(mid!.x).not.toBe(target!.x)
})

test('page transition applies a clip-path reveal mid-navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const supportsViewTransitions = await page.evaluate(
    () => typeof (document as unknown as { startViewTransition?: unknown }).startViewTransition === 'function',
  )
  test.skip(!supportsViewTransitions, 'browser has no View Transitions API support')

  const feedHeading = page.getByRole('heading', { name: 'Feed ao vivo' })
  const saudeHeading = page.getByRole('heading', { name: 'Saúde' })

  await page.addStyleTag({
    content: '::view-transition-new(root) { animation-duration: 6000ms !important; }',
  })
  await page.getByRole('link', { name: 'Saúde' }).click()
  await rafPumpWait(page, 950, 8)
  await page.screenshot({ path: '.impeccable/review/motion-page-transition-mid-clip.png' })

  // confirm the capture is really mid-reveal — some new-root animation still
  // running — after the screenshot, so this check can't perturb its timing.
  // The earlier version of this test never verified this at all (it also
  // predates a real bug: `viewTransition` on NavLink is a no-op under plain
  // <BrowserRouter>, so document.startViewTransition was never even called;
  // fixed in src/main.tsx by switching to createBrowserRouter+RouterProvider).
  const stillRevealing = await page.evaluate(
    () => document.getAnimations().some((a) => a.playState === 'running' && (a.effect?.getTiming().duration ?? 0) >= 1000),
  )
  expect(stillRevealing).toBe(true)

  // the old route's heading must already be gone (covered by the reveal)
  // and the new route's heading must already be visible (inside the
  // revealed region) — a capture that is either all-old or all-new (as a
  // race with the click, or a transition that never started, would produce)
  // fails one side of this.
  await expect(feedHeading).not.toBeVisible()
  await expect(saudeHeading).toBeVisible()
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
