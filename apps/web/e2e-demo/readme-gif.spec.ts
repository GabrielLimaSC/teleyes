import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * S27-05: records the README demo tour as a WebM from the demo stack — the
 * seeded, 100% fictional data of `scripts/seed_demo.py`, never a real deployment.
 *
 * Opt-in (`README_GIF=1`). The video lands in `$GIF_VIDEO_DIR` (default
 * `e2e-demo/.scratch/readme-gif`) as `tour.webm`; `scripts/record_readme_media.sh` turns
 * it into `docs/media/demo.gif`. Run the whole thing with that script.
 */
test.skip(process.env.README_GIF !== '1', 'README GIF recording is opt-in: set README_GIF=1')

test.describe.configure({ timeout: 180_000 })

const VIDEO_DIR = path.resolve(process.env.GIF_VIDEO_DIR ?? 'e2e-demo/.scratch/readme-gif')
const SIZE = { width: 1280, height: 800 }

async function pause(page: Page, ms: number) {
  await page.waitForTimeout(ms)
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
}

test('record the README tour: Ofertas, produto, Regras, Economia e tema escuro', async ({ browser }) => {
  fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
  fs.mkdirSync(VIDEO_DIR, { recursive: true })

  const baseURL = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:5184'
  // Sign in in a throwaway context so the recording starts on the feed, not on the login.
  const auth = await browser.newContext({ baseURL, viewport: SIZE, locale: 'pt-BR' })
  const authPage = await auth.newPage()
  await authPage.goto('/')
  await authPage.getByLabel('Senha').fill('demo-teleyes')
  await authPage.getByRole('button', { name: 'Entrar' }).click()
  await expect(authPage.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()
  const storageState = await auth.storageState()
  await auth.close()

  const context = await browser.newContext({
    baseURL,
    viewport: SIZE,
    colorScheme: 'light',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    storageState,
    recordVideo: { dir: VIDEO_DIR, size: SIZE },
  })
  const page = await context.newPage()

  // 1. Ofertas: live feed.
  await page.goto('/feed')
  await expect(page.getByText('Alvo atingido').first()).toBeVisible()
  await expect(page.getByText('Conectando…')).toHaveCount(0, { timeout: 15_000 })
  await settle(page)
  await pause(page, 3000)
  await page.mouse.wheel(0, 360)
  await pause(page, 1800)
  await page.mouse.wheel(0, -360)
  await pause(page, 1200)

  // 2. Product panel with the price chart.
  await page.locator('.match-card__product--button').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await pause(page, 3800)
  await page.getByRole('button', { name: 'Fechar painel do produto' }).click()
  await pause(page, 800)

  // 3. Regras.
  await page.goto('/regras')
  await expect(page.locator('.rules-table__row').first()).toBeVisible()
  await settle(page)
  await pause(page, 3000)

  // 4. Economia.
  await page.goto('/economia')
  await expect(page.getByRole('heading', { name: 'Economia' })).toBeVisible()
  await settle(page)
  await pause(page, 3000)

  // 5. Dark theme (Sistema → Claro → Escuro), back on the feed.
  await page.goto('/feed')
  await expect(page.getByText('Alvo atingido').first()).toBeVisible()
  await pause(page, 800)
  for (let i = 0; i < 3 && (await page.locator('html').getAttribute('data-theme')) !== 'dark'; i++) {
    await page.getByRole('button', { name: /^Tema:/ }).click()
    await pause(page, 500)
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await pause(page, 3500)

  await context.close()
  const video = fs.readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  expect(video).toBeTruthy()
  fs.renameSync(path.join(VIDEO_DIR, video as string), path.join(VIDEO_DIR, 'tour.webm'))
})
