import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const READ_ONLY_MESSAGE = 'Modo demonstração: alterações desativadas.'
const BANNER = 'Demonstração — dados fictícios, nada é salvo'

// Collects what a visitor would never want to see: console errors and failed requests.
function watchErrors(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('requestfailed', (request) => problems.push(`failed: ${request.url()}`))
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`)
  })
  return problems
}

test('the feed shows cards and the demo strip with the links', async ({ page }) => {
  const problems = watchErrors(page)
  await page.goto('feed')

  const strip = page.getByRole('note', { name: 'Aviso de modo demonstração' })
  await expect(strip).toContainText(BANNER)
  await expect(strip.getByRole('link', { name: 'Ver o código no GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/GabrielLimaSC/teleyes',
  )
  await expect(strip.getByRole('link', { name: 'Instalar o seu' })).toBeVisible()
  await expect(page.locator('.match-card').first()).toBeVisible()
  expect(await page.locator('.match-card').count()).toBeGreaterThan(5)
  expect(problems).toEqual([])
})

test('the product panel opens from a card and shows its history', async ({ page }) => {
  const problems = watchErrors(page)
  await page.goto('feed')

  await page.getByRole('button', { name: /Abrir produto/ }).first().click()
  const panel = page.locator('.product-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: '30d' })).toBeVisible()
  await panel.getByRole('tab', { name: '30d' }).click()
  await expect(panel.getByRole('tab', { name: '30d' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
  expect(problems).toEqual([])
})

test('rules, sources, history and health load without errors', async ({ page }) => {
  const problems = watchErrors(page)

  await page.goto('regras')
  await expect(page.locator('.crud-table__name').getByText('SSD NVMe exemplo', { exact: true })).toBeVisible()

  await page.goto('fontes')
  await expect(page.getByText('Grupo Demo Ofertas').first()).toBeVisible()

  await page.goto('historico')
  await expect(page.locator('.historico-table__title--button').first()).toBeVisible()

  await page.goto('saude')
  await expect(page.getByRole('heading', { name: /Saúde/ }).first()).toBeVisible()

  // The overview (Início) replaces the login: it is always signed in.
  await page.goto('')
  await expect(page.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()
  expect(problems).toEqual([])
})

test('a refresh on a deep link works under the subpath', async ({ page }) => {
  await page.goto('regras')
  await page.reload()
  await expect(page.locator('.crud-table__name').first()).toBeVisible()
  await expect(page.locator('img[src$="mascot.png"]').first()).toBeVisible()
  const src = await page.locator('img[src$="mascot.png"]').first().getAttribute('src')
  expect(src).toBe('/teleyes/mascot.png')
})

test('saving something shows the demo message and nothing changes', async ({ page }) => {
  await page.goto('regras')
  const row = page
    .locator('tr')
    .filter({ has: page.locator('.crud-table__name').getByText('SSD NVMe exemplo', { exact: true }) })

  await row.getByRole('switch', { name: 'ativa' }).click()

  await expect(page.locator('.toast')).toContainText(READ_ONLY_MESSAGE)
  await expect(row.getByRole('switch', { name: 'ativa' })).toBeVisible()
})

for (const width of [390, 1440]) {
  test(`no horizontal scroll at ${width}px on every page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    for (const route of ['', 'feed', 'regras', 'fontes', 'historico', 'saude']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `/${route} at ${width}px`).toBeLessThanOrEqual(0)
    }
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`renders in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('feed')
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await expect(page.locator('.match-card').first()).toBeVisible()
    await expect(page.getByRole('note', { name: 'Aviso de modo demonstração' })).toBeVisible()
  })
}
