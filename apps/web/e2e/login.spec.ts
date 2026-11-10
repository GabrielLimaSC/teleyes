import { expect, test } from '@playwright/test'

test('logs in against the real API, navigates the shell, and logs out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'teleyes' })).toBeVisible()

  await page.getByLabel('Senha').fill('e2e-test-password')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByText(/Sessão ativa/)).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await expect(nav.getByRole('link', { name: 'Início' })).toHaveClass(/nav-tab--active/)

  // session persists across a reload (real cookie, not just in-memory state)
  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()

  // S20-01: a fresh tab has no sessionStorage token — /auth/me hands it back,
  // so the session is whole (no "perdeu o token" warning) and Sair works.
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
  await expect(page.getByText(/perdeu o token/)).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('teleyes.csrf_token'))).toBeTruthy()

  // The desktop capsule keeps its links visible at rest.
  await expect(page.locator('.nav-capsule__glass')).toHaveCSS('opacity', '1')
  await nav.getByRole('link', { name: 'Ofertas' }).click()
  await expect(page.getByRole('heading', { name: 'Ofertas ao vivo' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Ofertas' })).toHaveClass(/nav-tab--active/)

  await nav.getByRole('link', { name: 'Início' }).click()
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByLabel('Senha')).toBeVisible()
})

test('redirects an anonymous visitor away from a gated page back to login', async ({ page }) => {
  await page.goto('/feed')

  await expect(page).toHaveURL('/')
  await expect(page.getByLabel('Senha')).toBeVisible()
})

test('phone "Mais" sheet navigates and closes after choosing a page', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 })
  await page.goto('/')
  await page.getByLabel('Senha').fill('e2e-test-password')
  await page.getByRole('button', { name: 'Entrar' }).click()

  // S24-01: on a phone the capsule gives way to the tab bar; the rest lives in "Mais".
  await page.getByRole('button', { name: 'Mais', exact: true }).click()
  await page.getByRole('dialog', { name: 'Mais' }).getByRole('link', { name: 'Saúde' }).click()

  await expect(page).toHaveURL('/saude')
  await expect(page.getByRole('heading', { name: 'Saúde' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('shows an error and stays logged out on a wrong password', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('Senha').fill('definitely-wrong')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByRole('alert')).toHaveText('Senha incorreta.')
  await expect(page.getByLabel('Senha')).toBeVisible()
})
