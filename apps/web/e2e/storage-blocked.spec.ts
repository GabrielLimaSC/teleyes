import { expect, test } from '@playwright/test'

/**
 * S12-04: a browser that blocks web storage (Safari private mode with strict
 * settings, "block all cookies" in Chrome, an enterprise policy) makes every
 * `Storage` call THROW. The app must still open, sign in and work: the CSRF
 * token then lives in memory only, and a reload asks for a new sign-in.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    Storage.prototype.getItem = blocked
    Storage.prototype.setItem = blocked
    Storage.prototype.removeItem = blocked
  })
})

test('with web storage blocked the app still opens, signs in, saves and signs out', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.getByLabel('Senha')).toBeVisible()

  await page.getByLabel('Senha').fill('e2e-test-password')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()

  // The token is in memory: a mutation still carries it.
  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await nav.getByRole('link', { name: 'Regras' }).click()
  await page.getByLabel(/^Nome/).fill('Regra sem armazenamento')
  await page.getByLabel(/Termos incluídos/).fill('semarmazenamento')
  await page.getByLabel(/Termos incluídos/).press('Enter')
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expect(page.getByRole('status')).toContainText('Regra criada.')

  // The theme button still cycles (its choice just is not remembered).
  await page.getByRole('button', { name: /^Tema: / }).click()
  await expect(page.getByRole('button', { name: 'Tema: Claro' })).toBeVisible()

  await nav.getByRole('link', { name: 'Login' }).click()
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByLabel('Senha')).toBeVisible()

  expect(errors).toEqual([])
})
