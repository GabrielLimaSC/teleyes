import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * S19-03: generates the README screenshots from the demo stack — the seeded,
 * 100% fictional data of `scripts/seed_demo.py`, never a real deployment.
 *
 * Opt-in (`SCREENSHOTS=1`) so the everyday run produces no image files. Output
 * goes to `docs/screenshots/`, versioned in Git so `README.md` renders on GitHub.
 *
 * Against the real Docker stack (the intended source of the README images):
 *
 *   docker compose -p teleyes-shots -f docker-compose.demo.yml up --build -d
 *   SCREENSHOTS=1 DEMO_BASE_URL=http://127.0.0.1:18080 \
 *     npx playwright test -c playwright.demo.config.ts e2e-demo/screenshots.spec.ts
 *
 * Without `DEMO_BASE_URL` it uses the seeded scratch backend of the Playwright run.
 */
test.skip(process.env.SCREENSHOTS !== '1', 'README screenshot generation is opt-in: set SCREENSHOTS=1')

test.describe.configure({ mode: 'serial', timeout: 120_000 })
// Dark theme, matching the concept approved for the portfolio shots ("Sistema",
// the default theme choice, follows this at first paint).
test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
})

const OUT_DIR = '../../docs/screenshots'

async function shoot(page: Page, name: string) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, animations: 'disabled' })
}

test('capture Login, Feed, Histórico, Regras, Fontes and Saúde from the demo', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('demo-login-hint')).toBeVisible()
  await shoot(page, 'login')

  await page.getByLabel('Senha').fill('demo-teleyes')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()

  await page.goto('/feed')
  await expect(page.getByText('Alvo atingido').first()).toBeVisible()
  await shoot(page, 'feed')

  await page.goto('/historico')
  await expect(page.locator('.historico-table').getByText('Exemplo').first()).toBeVisible()
  await shoot(page, 'historico')

  await page.goto('/regras')
  await expect(page.locator('.rule-sparkline').first()).toBeVisible()
  await shoot(page, 'regras')

  await page.goto('/fontes')
  await expect(page.getByText('Grupo Demo Ofertas').first()).toBeVisible()
  await shoot(page, 'fontes')

  await page.goto('/saude')
  await expect(page.getByText('Ambiente')).toBeVisible()
  await shoot(page, 'saude')
})
