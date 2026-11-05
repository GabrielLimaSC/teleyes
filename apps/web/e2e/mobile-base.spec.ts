import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S24-01: phone layout base (390x844): tab bar, "Mais" sheet, menus as sheets.
test.use({ viewport: { width: 390, height: 844 } })

const ROUTES = ['/', '/feed', '/regras', '/economia', '/historico', '/fontes', '/saude', '/configuracao']

test('tab bar replaces the capsule, and the five tabs navigate', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/')

  const tabs = page.getByRole('navigation', { name: 'Navegação principal' })
  await expect(tabs).toBeVisible()
  await expect(page.locator('.nav-capsule')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: /Ao vivo|Conectando|Sem conexão/ })).toBeVisible()

  const bar = await tabs.boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(844)
  for (const link of await tabs.getByRole('link').all()) {
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }

  for (const [name, path] of [
    ['Ofertas', '/feed'],
    ['Regras', '/regras'],
    ['Economia', '/economia'],
    ['Início', '/'],
  ] as const) {
    await tabs.getByRole('link', { name }).click()
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path}$`))
    await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page')
  }
})

test('"Mais" opens a sheet and the back button closes it without leaving the page', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  await page.getByRole('button', { name: 'Mais', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Mais' })
  await expect(sheet).toBeVisible()
  for (const name of ['Histórico', 'Grupos', 'Saúde', 'Configuração']) {
    await expect(sheet.getByRole('link', { name })).toBeVisible()
  }
  await expect(sheet.getByRole('radio', { name: 'Escuro' })).toBeVisible()

  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/feed$/)

  // A link inside the sheet takes the sheet's history entry.
  await page.getByRole('button', { name: 'Mais', exact: true }).click()
  await page.getByRole('dialog', { name: 'Mais' }).getByRole('link', { name: 'Grupos' }).click()
  await expect(page).toHaveURL(/\/fontes$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/feed$/)

  // Theme segment applies at once; "Sair" asks first.
  await page.getByRole('button', { name: 'Mais', exact: true }).click()
  await page.getByRole('radio', { name: 'Escuro' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('radio', { name: 'Claro' }).click()
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Cancelar' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('the row menu of an offer card opens as a sheet inside the screen', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo Celular',
    telegram_chat_id: '-100824',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra Celular',
    include_terms: 'gadgetcelular',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Destino Celular',
    telegram_chat_id: '924',
    allowlisted: true,
  })
  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetcelular por R$ 100',
  })

  const trigger = page.getByRole('button', { name: 'Mais ações' }).first()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const menu = page.getByRole('dialog').getByRole('menu')
  await expect(menu).toBeVisible()
  // The sheet rises in 220ms: measure once it has settled.
  await page.waitForTimeout(400)
  const box = await page.getByRole('dialog').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('"Ajustes de entrega" opens as a sheet inside the screen', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')
  const trigger = page.getByRole('button', { name: 'Ajustes de entrega' }).first()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Entrega dos alertas' })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})

test('no route scrolls horizontally', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  for (const path of ROUTES) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0)
  }
})
