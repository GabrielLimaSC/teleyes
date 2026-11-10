import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

test('saude page reflects the real not_configured state and tests a notification honestly', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  await apiPost(page, '/recipients', csrfToken, {
    name: 'Gabriel Saude E2E',
    telegram_chat_id: '997',
    allowlisted: true,
  })

  await page.goto('/saude')

  await expect(page.getByText('Ambiente', { exact: true })).toBeVisible()
  // this E2E backend runs with no TG_API_ID/BOT_TOKEN (e2e/start-backend.sh) —
  // both real health fields must say so, never a faked "connected"/"configured".
  await expect(page.locator('.saude-pill', { hasText: 'desligado' })).toHaveCount(2)

  await page.getByLabel('Destinatário').selectOption({ label: 'Gabriel Saude E2E' })
  await page.getByRole('button', { name: 'Enviar teste' }).click()

  await expect(page.getByText('Não entregue — status: not_configured.')).toBeVisible()
})

test('saude summary shows the real totals from the API (S11-06)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  await apiPost(page, '/sources', csrfToken, { name: 'Grupo E2E Saude Resumo', telegram_chat_id: '-100840' })

  // Other workers seed sources/matches into the same scratch backend while
  // this test runs, so an exact equality against one API read races. The
  // page's numbers must fall between a read taken before it loads and one
  // taken after it has rendered them.
  const readTotals = () =>
    page.evaluate(async () => {
      const json = async (path: string) =>
        (await (await fetch(path, { credentials: 'same-origin' })).json()) as unknown[]
      return {
        sources: (await json('/sources')).length,
        matches: (await json('/matches')).length,
      }
    })
  const before = await readTotals()
  expect(before.sources).toBeGreaterThanOrEqual(1)

  await page.goto('/saude')
  const stat = (label: string) => page.locator('.saude-stats__item', { hasText: label })
  const shown = async (label: string) => {
    await expect(stat(label).locator('dd')).toHaveText(/^\d/)
    return Number((await stat(label).locator('dd').innerText()).replace(/\D/g, ''))
  }
  const shownSources = await shown('Grupos ativos')
  const shownMatches = await shown('Ofertas encontradas')
  const after = await readTotals()
  expect(shownSources).toBeGreaterThanOrEqual(before.sources)
  expect(shownSources).toBeLessThanOrEqual(after.sources)
  expect(shownMatches).toBeGreaterThanOrEqual(before.matches)
  expect(shownMatches).toBeLessThanOrEqual(after.matches)
  await expect(page.getByText('Mensagens lidas')).toHaveCount(0)
})

test('saude v2 shows the verdict, five service cards with 24 bars and the collector (S21-10)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/saude')

  await expect(page.getByRole('heading', { name: 'Saúde' })).toBeVisible()
  await expect(page.getByText(/atualizado há \d+s/)).toBeVisible()
  // Telegram and bot are off in this backend: never "Tudo funcionando".
  await expect(page.locator('.saude-verdict h2')).not.toHaveText('Tudo funcionando')
  await expect(page.locator('.saude-verdict')).toContainText(/\d de 5 serviços ativos/)

  const cards = page.locator('.saude-service')
  await expect(cards).toHaveCount(5)
  for (const name of ['Telegram', 'Bot', 'Leitor do Telegram', 'Atualização ao vivo', 'Banco']) {
    await expect(cards.filter({ has: page.getByRole('heading', { name, exact: true }) })).toHaveCount(1)
    await expect(cards.filter({ has: page.getByRole('heading', { name, exact: true }) }).locator('.saude-bar')).toHaveCount(24)
  }
  await expect(page.getByRole('heading', { name: 'Coletor' })).toBeVisible()
  await expect(page.getByText(/Mensagens analisadas por hora · últimas 24h/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Eventos recentes' })).toBeVisible()
})

test('saude Reverificar refetches the history and the preview follows the message (S21-10)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/saude')
  await expect(page.locator('.saude-service')).toHaveCount(5)

  const refetch = page.waitForResponse((response) => response.url().includes('/health/history'))
  await page.getByRole('button', { name: 'Reverificar' }).click()
  expect((await refetch).ok()).toBe(true)

  await page.getByLabel('Mensagem').fill('Mensagem na bolha E2E')
  await expect(page.getByLabel('Prévia no Telegram')).toContainText('Mensagem na bolha E2E')
  await expect(page.getByLabel('Prévia no Telegram')).toContainText('teleyes')
})
