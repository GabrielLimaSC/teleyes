import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S13-06 — "Aplicar regras". The e2e backend runs without a listener process,
// so what is exercised for real is the panel <-> API half: the notice that
// follows a real change, the real POST (CSRF included) and the pending state a
// missing listener honestly produces. What the listener does with the request
// is covered by the integration tests in apps/api/tests/test_listener_reload.py.
// The other states are served by `page.route` so they can be looked at, in
// both themes and both widths.

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const

const APPLIED = {
  state: 'idle',
  reload_requested_at: '2026-09-21T17:30:00Z',
  reload_applied_at: '2026-09-21T17:32:00Z',
  sources_loaded: 2,
  rules_loaded: 6,
  recipients_loaded: 1,
  new_matches: 3,
  scan_failures: 0,
  error: null,
  has_unapplied_changes: false,
  listener_online: true,
  listener_seen_at: '2026-09-21T17:40:00Z',
} as const

async function serveStatus(page: Page, status: Record<string, unknown>) {
  await page.route('**/listener/status', (route) => route.fulfill({ json: status }))
}

test('a real change raises the notice, and the button sends a real request', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  await apiPost(page, '/rules', csrfToken, { name: 'Regra Aplicar E2E', include_terms: 'aplicar' })

  await page.goto('/regras')

  await expect(page.getByText('Há mudanças ainda não aplicadas')).toBeVisible()
  const button = page.getByRole('button', { name: 'Aplicar regras' })
  await expect(button).toBeEnabled()

  await button.click()

  // No listener process here, so the request honestly stays pending.
  await expect(page.getByRole('button', { name: 'Aplicando…' })).toBeDisabled()
  await expect(page.getByText('Aguardando o listener…')).toBeVisible()
  await expect(page.getByText(/O listener não está respondendo/)).toBeVisible()

  const status = await page.evaluate(async () => {
    const response = await fetch('/listener/status', { credentials: 'same-origin' })
    return (await response.json()) as { state: string; reload_requested_at: string }
  })
  expect(status.state).toBe('pending')
  expect(status.reload_requested_at).toMatch(/Z$/)
})

test('the API refuses the request without the CSRF token', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)

  const status = await page.evaluate(async () => {
    const response = await fetch('/listener/reload', { method: 'POST', credentials: 'same-origin' })
    return response.status
  })

  expect(status).toBe(403)
})

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`every state reads well: ${scheme} theme, ${viewport.name}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      await apiLogin(page)

      const states = [
        { key: 'unapplied', status: { ...APPLIED, has_unapplied_changes: true }, text: 'Há mudanças ainda não aplicadas' },
        { key: 'applying', status: { ...APPLIED, state: 'applying', has_unapplied_changes: true }, text: 'Aplicando…' },
        {
          key: 'failed',
          status: { ...APPLIED, state: 'failed', error: 'ConnectionError', has_unapplied_changes: true },
          text: 'Falha ao aplicar',
        },
        { key: 'applied', status: APPLIED, text: 'Regras aplicadas' },
        { key: 'offline', status: { ...APPLIED, listener_online: false }, text: 'Listener sem sinal' },
      ] as const

      for (const state of states) {
        await page.unroute('**/listener/status')
        await serveStatus(page, state.status)
        await page.goto('/regras')

        const panel = page.locator('.listener-apply')
        await expect(panel).toContainText(state.text)
        await expect(panel.getByRole('button')).toBeVisible()
        const [scrollWidth, clientWidth] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ])
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
        await panel.screenshot({
          path: `test-results/aplicar-regras/${scheme}-${viewport.name}-${state.key}.png`,
        })
      }

      await page.unroute('**/listener/status')
      await serveStatus(page, { ...APPLIED, has_unapplied_changes: true })
      await page.goto('/regras')
      await expect(page.locator('.listener-apply')).toBeVisible()
      await page.screenshot({
        path: `test-results/aplicar-regras/${scheme}-${viewport.name}-page.png`,
        fullPage: true,
      })

      await page.unroute('**/listener/status')
      await serveStatus(page, { ...APPLIED, has_unapplied_changes: true })
      await page.goto('/saude')
      const tile = page.locator('.saude-tile', { hasText: 'Listener' })
      await expect(tile).toContainText('Mudanças pendentes')
      await expect(tile).toContainText('Aplique na página Regras.')
      await page.screenshot({
        path: `test-results/aplicar-regras/${scheme}-${viewport.name}-saude.png`,
        fullPage: true,
      })
    })
  }
}

test('keyboard: the apply button takes focus and shows the focus ring', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await serveStatus(page, { ...APPLIED, has_unapplied_changes: true })
  await page.goto('/regras')

  const button = page.getByRole('button', { name: 'Aplicar regras' })
  await button.focus()

  await expect(button).toBeFocused()
  const shadow = await button.evaluate((node) => getComputedStyle(node).boxShadow)
  expect(shadow).not.toBe('none')
})
