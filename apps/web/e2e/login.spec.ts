import { expect, test } from '@playwright/test'

test('logs in against the real API, navigates the shell, and logs out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'teleyes' })).toBeVisible()

  await page.getByLabel('Senha').fill('e2e-test-password')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByText(/Sessão ativa/)).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await expect(nav.getByRole('link', { name: 'Login' })).toHaveClass(/nav-tab--active/)

  // session persists across a reload (real cookie, not just in-memory state)
  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()

  // the nav capsule switches pages, including the ones still empty in this task
  await page.locator('.nav-mascot').hover()
  await expect(page.locator('.nav-capsule__glass')).toHaveCSS('opacity', '1')
  await nav.getByRole('link', { name: 'Feed' }).click()
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Feed' })).toHaveClass(/nav-tab--active/)

  await nav.getByRole('link', { name: 'Login' }).click()
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByLabel('Senha')).toBeVisible()
})

test('redirects an anonymous visitor away from a gated page back to login', async ({ page }) => {
  await page.goto('/feed')

  await expect(page).toHaveURL('/')
  await expect(page.getByLabel('Senha')).toBeVisible()
})

test('shows an error and stays logged out on a wrong password', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('Senha').fill('definitely-wrong')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByRole('alert')).toHaveText('Senha incorreta.')
  await expect(page.getByLabel('Senha')).toBeVisible()
})
