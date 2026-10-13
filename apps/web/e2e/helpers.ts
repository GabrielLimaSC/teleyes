import type { Page } from '@playwright/test'

export const E2E_PASSWORD = 'e2e-test-password'

// `page.request` has its own cookie jar that doesn't apply the browser's
// "localhost counts as a secure context" rule the same way page fetches do,
// so a Secure session cookie set through it never sticks. Driving this
// through page.evaluate() runs it as a real in-page fetch — same as the app
// itself — so the session cookie behaves exactly like it does for a user.
export async function apiLogin(page: Page): Promise<string> {
  return page.evaluate(async (password) => {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    })
    const body = (await response.json()) as { csrf_token: string }
    // Mirror what AuthContext.login() does — pages that read csrfToken from
    // useAuth() (Regras/Fontes/etc.) need it in sessionStorage, not just
    // returned here, or their mutations silently no-op on a null token.
    sessionStorage.setItem('teleyes.csrf_token', body.csrf_token)
    return body.csrf_token
  }, E2E_PASSWORD)
}

export async function apiPost<T>(page: Page, path: string, csrfToken: string, data: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, csrfToken, data }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      })
      return (await response.json()) as unknown
    },
    { path, csrfToken, data },
  ) as Promise<T>
}

export async function apiPut<T>(page: Page, path: string, csrfToken: string, data: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, csrfToken, data }) => {
      const response = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      })
      return (await response.json()) as unknown
    },
    { path, csrfToken, data },
  ) as Promise<T>
}

/**
 * S16-02: clicks a rule inside the Feed's "Filtrar por regra" rail —
 * (`FeedPage.tsx`) only shows the 6 busiest rules by default, "Ver todas ·
 * N" reveals the rest. The e2e backend is shared and accumulates rules
 * across specs (and repeats of the same spec), so any rule can end up
 * behind that fold — every spec that filters the Feed by rule name goes
 * through this instead of clicking the rail button directly, opening "Ver
 * todas" first when needed. Works the same at 390px: the rail swaps DOM
 * order below the card list there (`FeedPage.css`'s `@media (max-width:
 * 1100px)`), but the fold itself isn't gated by viewport width.
 */
export async function clickRuleFilter(page: Page, name: string | RegExp): Promise<void> {
  // Waits for the rail's own data (rules) to have rendered at all, so an
  // `isVisible()` check right after `page.goto` never reads a false
  // negative from a still-loading rail.
  await page.locator('.feed-rail__rule').first().waitFor({ state: 'visible' })
  const ruleButton = page.getByRole('button', { name })
  let expanded = false
  if (!(await ruleButton.isVisible())) {
    const moreButton = page.getByRole('button', { name: /^Ver todas/ })
    if (await moreButton.isVisible()) {
      await moreButton.click()
      expanded = true
    }
  }
  await ruleButton.click()
  if (expanded) {
    // "Ver todas" can grow the rail tall enough (many rules accumulated on
    // the shared e2e backend) that Playwright's scroll-into-view for either
    // click leaves the page scrolled past the Feed's own compact-chrome
    // threshold (chrome/scrollChrome.ts, >1100px wide) — the grid's rails
    // then spring their columns for 680ms. Scrolling back to the top and
    // waiting that out means a caller that measures card/rail geometry
    // right after this call never catches it mid-flight.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(900)
  }
}
