import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin } from './helpers'

const PASSWORD = 'e2e-test-password'

async function uiLogin(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
}

/** Makes the *next* write to `path` fail as an expired session/CSRF would,
 * then lets every following request through for real — mirrors reality: the
 * stale token/session breaks exactly once, and a fresh one (from reauth)
 * works again. */
async function failNextWriteWithExpiredCsrf(page: Page, path: string): Promise<void> {
  let used = false
  await page.route(`**${path}`, (route) => {
    if (!used && route.request().method() !== 'GET') {
      used = true
      void route.fulfill({ status: 403, json: { detail: 'invalid csrf token' } })
      return
    }
    void route.continue()
  })
}

// S13-08: the bug Gabriel actually hit — a write fails on an expired
// session/CSRF token, and instead of the raw "invalid csrf token" detail,
// a clear modal appears, the half-filled form survives, and the same
// action succeeds once reauthenticated — no page reload anywhere in this
// test.
test('an expired session during a write shows a clear prompt, keeps the form, and the action succeeds after reauth', async ({
  page,
}) => {
  await uiLogin(page)
  await page.goto('/regras')
  await failNextWriteWithExpiredCsrf(page, '/rules')

  await page.getByLabel(/Nome/).fill('Sessão Expirada E2E')
  await page.getByLabel(/Termos incluídos/).fill('sessao expirada e2e')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  const dialog = page.getByRole('dialog', { name: 'Sua sessão expirou' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Digite sua senha')

  // Never the raw backend detail, anywhere on the page.
  await expect(page.getByText('invalid csrf token')).toHaveCount(0)

  // The form behind the modal is untouched — nothing was lost. The chips
  // input commits its typed-but-uncommitted term on blur (S11-05, same as
  // clicking "Criar regra" directly would), which is exactly what moving
  // focus into the modal's password field does — so it shows up as a
  // chip, not raw input text, and that is the term surviving intact.
  await expect(page.getByLabel(/Nome/)).toHaveValue('Sessão Expirada E2E')
  await expect(page.getByRole('button', { name: 'Remover termo sessao expirada e2e' })).toBeVisible()

  await dialog.getByLabel('Senha').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entrar e continuar' }).click()

  await expect(dialog).toBeHidden()
  // The exact same "Criar regra" click's request is retried automatically
  // — the rule ends up created without the admin doing anything else.
  await expect(
    page.locator('tr').filter({ has: page.locator('.crud-table__name', { hasText: 'Sessão Expirada E2E' }) }),
  ).toBeVisible()
})

test('a wrong password in the reauth modal shows an inline error and lets the admin try again', async ({
  page,
}) => {
  await uiLogin(page)
  await page.goto('/regras')
  await failNextWriteWithExpiredCsrf(page, '/rules')

  await page.getByLabel(/Nome/).fill('Senha Errada E2E')
  await page.getByLabel(/Termos incluídos/).fill('senha errada e2e')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  const dialog = page.getByRole('dialog', { name: 'Sua sessão expirou' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Senha').fill('definitely-wrong')
  await dialog.getByRole('button', { name: 'Entrar e continuar' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Senha incorreta.')
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Senha').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Entrar e continuar' }).click()

  await expect(dialog).toBeHidden()
  await expect(
    page.locator('tr').filter({ has: page.locator('.crud-table__name', { hasText: 'Senha Errada E2E' }) }),
  ).toBeVisible()
})

// Multi-tab: reauthenticating in one tab must not leave the other tab
// stuck showing a confusing "sessão expirou" prompt of its own. Cookies are
// shared across tabs of the same browser profile, so a brand new tab is
// already authenticated the moment it loads (no login form to fill) — the
// realistic way a *second* tab ends up needing to reauthenticate is the
// exact same trigger as the first, which is what this reproduces.
test('reauthenticating in one tab clears the expired-session prompt in another tab', async ({
  page,
  context,
}) => {
  await uiLogin(page)
  await page.goto('/regras')
  await failNextWriteWithExpiredCsrf(page, '/rules')

  await page.getByLabel(/Nome/).fill('Multi Aba E2E')
  await page.getByLabel(/Termos incluídos/).fill('multi aba e2e')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  const dialog = page.getByRole('dialog', { name: 'Sua sessão expirou' })
  await expect(dialog).toBeVisible()

  // A second tab, same browser/profile. Its cookie is already valid (shared
  // jar), so it never sees a login form of its own to type a password into
  // (S12-04's `csrfMissing`, a separate concern from this task) — `apiLogin`
  // bootstraps its CSRF token the same way `AuthContext.login()` would, so
  // it can reach the same write-fails-then-reauth flow this task covers.
  const otherPage = await context.newPage()
  await otherPage.goto('/')
  await apiLogin(otherPage)
  await otherPage.goto('/regras')
  await expect(otherPage.getByRole('heading', { name: 'Regras' })).toBeVisible()
  await failNextWriteWithExpiredCsrf(otherPage, '/rules')

  await otherPage.getByLabel(/Nome/).fill('Multi Aba Outra E2E')
  await otherPage.getByLabel(/Termos incluídos/).fill('multi aba outra e2e')
  await otherPage.getByRole('button', { name: 'Criar regra' }).click()

  const otherDialog = otherPage.getByRole('dialog', { name: 'Sua sessão expirou' })
  await expect(otherDialog).toBeVisible()

  // It reauthenticates for real.
  await otherDialog.getByLabel('Senha').fill(PASSWORD)
  await otherDialog.getByRole('button', { name: 'Entrar e continuar' }).click()
  await expect(otherDialog).toBeHidden()
  await expect(
    otherPage.locator('tr').filter({ has: otherPage.locator('.crud-table__name', { hasText: 'Multi Aba Outra E2E' }) }),
  ).toBeVisible()

  // Back in the first tab: its modal clears on its own (the other tab's
  // fresh token arrived over the `storage` broadcast) — the admin never
  // had to type their password a second time there, and no error was left
  // dangling behind it.
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  await expect(page.getByText('invalid csrf token')).toHaveCount(0)
  // The original write that triggered the first tab's prompt is retried
  // with the adopted token and succeeds too.
  await expect(
    page.locator('tr').filter({ has: page.locator('.crud-table__name', { hasText: 'Multi Aba E2E' }) }),
  ).toBeVisible()

  await otherPage.close()
})
