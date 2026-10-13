import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S13-10: generates the README screenshots from demonstration data only.
 *
 * Runs against the same isolated test backend the rest of the Playwright
 * suite uses (`e2e/start-backend.sh`: fresh scratch SQLite, no `.env`, no
 * Telegram/bot credentials — `telegram`/`bot` come back `not_configured`,
 * which is the honest state and exactly what a fresh checkout looks like).
 * Every source, rule, recipient and message below is fictional — invented
 * for this script, never copied from a real teleyes deployment. Nothing
 * here is a real Telegram group name, chat id, price or secret.
 *
 * Opt-in (`SCREENSHOTS=1`) so the everyday suite doesn't produce image
 * files on every run. Output goes to `docs/screenshots/`, versioned in Git
 * so the images referenced by `README.md` render on GitHub.
 *
 *   SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 */
test.skip(process.env.SCREENSHOTS !== '1', 'README screenshot generation is opt-in: set SCREENSHOTS=1')

test.describe.configure({ mode: 'serial', timeout: 120_000 })
// Dark theme, matching the concept Gabriel approved for the portfolio shots.
// "Sistema" (the default theme choice) follows this at first paint.
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC' })

const OUT_DIR = '../../docs/screenshots'

async function shoot(page: import('@playwright/test').Page, name: string) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: true, animations: 'disabled' })
}

test('capture Login, Feed, Histórico, Regras, Fontes and Saúde with demo data', async ({ page }) => {
  // ---- Login (anonymous) ----
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'teleyes' })).toBeVisible()
  await shoot(page, 'login')

  const csrf = await apiLogin(page)

  // ---- Seed clearly fictional demo data ----
  const sourceA = await apiPost<{ id: number }>(page, '/sources', csrf, {
    name: 'Loja Demo Eletrônicos',
    telegram_chat_id: 'demo-source-eletronicos',
  })
  const sourceB = await apiPost<{ id: number }>(page, '/sources', csrf, {
    name: 'Loja Demo Informática',
    telegram_chat_id: 'demo-source-informatica',
  })

  const rules = {
    gpu: await apiPost<{ id: number }>(page, '/rules', csrf, {
      name: 'RTX 5090 exemplo',
      include_terms: 'rtx 5090',
      max_price_cents: 900000,
    }),
    headphones: await apiPost<{ id: number }>(page, '/rules', csrf, {
      name: 'Fone bluetooth exemplo',
      include_terms: 'fone bluetooth',
      exclude_terms: 'usado, defeito',
    }),
    laptop: await apiPost<{ id: number }>(page, '/rules', csrf, {
      name: 'Notebook exemplo',
      include_terms: 'notebook, laptop',
      max_price_cents: 500000,
    }),
  }

  const admin = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: 'Admin Demo',
    telegram_chat_id: 'demo-recipient-admin',
    allowlisted: true,
  })
  const second = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: 'Segundo destinatário Demo',
    telegram_chat_id: 'demo-recipient-2',
    allowlisted: true,
  })

  const send = (
    source: { id: number },
    rule: { id: number },
    text: string,
    recipientIds: number[],
    link?: string,
  ) => apiPost(page, '/demo/messages', csrf, { source_id: source.id, rule_id: rule.id, recipient_ids: recipientIds, text, link })

  await send(sourceA, rules.gpu, 'Placa de vídeo RTX 5090 exemplo por R$ 8.999 https://exemplo.com/rtx5090', [admin.id, second.id], 'https://t.me/c/demo/1')
  await send(sourceB, rules.headphones, 'Fone bluetooth exemplo modelo X por R$ 299 https://exemplo.com/fone', [admin.id])
  await send(sourceA, rules.laptop, 'Notebook exemplo 15 polegadas por R$ 3.499 https://exemplo.com/notebook', [admin.id, second.id], 'https://t.me/c/demo/3')
  await send(sourceB, rules.gpu, 'RTX 5090 exemplo edição especial por R$ 9.499 https://exemplo.com/rtx5090b', [admin.id])

  // ---- Feed ----
  await page.goto('/feed')
  await expect(page.getByText('RTX 5090 exemplo').first()).toBeVisible()
  await page.waitForTimeout(400)
  await shoot(page, 'feed')

  // ---- Histórico ---- (scoped to the results table: the filter rail also
  // renders a <select> with the same rule name as a hidden <option>)
  await page.goto('/historico')
  await expect(page.locator('.historico-table').getByText('RTX 5090 exemplo').first()).toBeVisible()
  await page.waitForTimeout(400)
  await shoot(page, 'historico')

  // ---- Regras ----
  await page.goto('/regras')
  await expect(page.getByText('RTX 5090 exemplo').first()).toBeVisible()
  await page.waitForTimeout(400)
  await shoot(page, 'regras')

  // ---- Fontes ----
  await page.goto('/fontes')
  await expect(page.getByText('Loja Demo Eletrônicos').first()).toBeVisible()
  await page.waitForTimeout(400)
  await shoot(page, 'fontes')

  // ---- Saúde ---- (real /health of the isolated test server: no Telegram/bot
  // credentials exist in this environment, so both come back honestly
  // `not_configured` — the same state a fresh checkout looks like.)
  await page.goto('/saude')
  await expect(page.getByText('Ambiente')).toBeVisible()
  await page.waitForTimeout(400)
  await shoot(page, 'saude')
})
