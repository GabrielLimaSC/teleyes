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

  await expect(page.getByText('Ambiente')).toBeVisible()
  // this E2E backend runs with no TG_API_ID/BOT_TOKEN (e2e/start-backend.sh) —
  // both real health fields must say so, never a faked "connected"/"configured".
  await expect(page.getByText('Não configurado')).toHaveCount(2)

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
  const shownSources = await shown('Fontes ativas')
  const shownMatches = await shown('Matches gerados')
  const after = await readTotals()
  expect(shownSources).toBeGreaterThanOrEqual(before.sources)
  expect(shownSources).toBeLessThanOrEqual(after.sources)
  expect(shownMatches).toBeGreaterThanOrEqual(before.matches)
  expect(shownMatches).toBeLessThanOrEqual(after.matches)
  await expect(page.getByText('Mensagens lidas')).toHaveCount(0)
  await expect(page.getByText(/Contagens de agora/)).toBeVisible()
})
