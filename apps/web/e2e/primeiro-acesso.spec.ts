import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S23-04: first access on an empty install. The shared e2e backend has no
 * Telegram, so step 1 (account connected) is stood in for the way the card
 * itself accepts it, "there is already a source", created through the real
 * `POST /sources`; the bot pairing is stood in by a real, authorized
 * recipient (`POST /recipients`). The rule is created through the real UI.
 * The real Telegram login and pairing are covered by e2e-setup/wizard.spec.ts.
 */

/** Empties rules, sources and recipients through the real API: "a fresh install". */
async function wipe(page: Page, csrf: string): Promise<void> {
  await page.evaluate(async (token) => {
    for (const path of ['/rules?include_inactive=true', '/sources?include_inactive=true', '/recipients?include_inactive=true']) {
      const items = (await (await fetch(path, { credentials: 'same-origin' })).json()) as { id: number }[]
      const base = path.split('?')[0]
      for (const item of items) {
        await fetch(`${base}/${item.id}`, { method: 'DELETE', headers: { 'x-csrf-token': token }, credentials: 'same-origin' })
      }
    }
  }, csrf)
}

async function freshInstall(page: Page): Promise<string> {
  await page.goto('/')
  const csrf = await apiLogin(page)
  await wipe(page, csrf)
  await page.evaluate(() => window.localStorage.clear())
  return csrf
}

test('guides a new install through the three steps until "Tudo pronto"', async ({ page }) => {
  const csrf = await freshInstall(page)

  await page.goto('/')
  const card = page.getByRole('region', { name: 'Comece por aqui' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

  // Step 1 opens the existing wizard.
  await card.getByRole('link', { name: 'Conectar o Telegram' }).click()
  await expect(page).toHaveURL(/\/configuracao$/)
  await expect(page.getByRole('heading', { name: /Configuração/ }).first()).toBeVisible()

  // Telegram connected (stood in by a source), back on Início.
  await apiPost(page, '/sources', csrf, { name: 'Grupo Primeiro Acesso', telegram_chat_id: 'pa-src-1' })
  await page.goto('/')
  await expect(card.getByText('Telegram conectado, 1 grupo em monitoramento.')).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')

  // Step 2: an authorized recipient.
  await apiPost(page, '/recipients', csrf, { name: 'Gabriel', telegram_chat_id: 'pa-chat-1', allowlisted: true })
  await page.goto('/')
  await expect(card.getByText('1 destinatário autorizado para receber alertas.')).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')

  // Step 3 lands on Regras with the form focused, and creating a rule finishes the card.
  await card.getByRole('link', { name: 'Criar a primeira regra' }).click()
  await expect(page).toHaveURL(/\/regras$/)
  const name = page.getByLabel(/Nome/)
  await expect(name).toBeFocused()
  await name.fill('Primeira regra E2E')
  await page.getByLabel(/O que você procura/).fill('placa de video')
  await page.getByLabel(/O que você procura/).press('Enter')
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expect(page.getByText('Primeira regra E2E').first()).toBeVisible()

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Tudo pronto' }).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')

  // A new page load: gone for good.
  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
  await expect(page.getByRole('heading', { name: /Tudo pronto|Comece por aqui/ })).toHaveCount(0)
})

test('"Pular por agora" dismisses the card and it stays dismissed', async ({ page }) => {
  await freshInstall(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Pular por agora' }).click()
  await expect(page.getByRole('heading', { name: 'Comece por aqui' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(/Sessão ativa/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Comece por aqui' })).toHaveCount(0)
})

test('is reachable with the keyboard and announces a finished step only when it changes', async ({ page }) => {
  const csrf = await freshInstall(page)
  await page.goto('/')
  const card = page.getByRole('region', { name: 'Comece por aqui' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('status')).toHaveText('')

  // Tab order: skip link, nav..., then the card. Focus each control by Tab until the link is reached.
  const link = card.getByRole('link', { name: 'Conectar o Telegram' })
  for (let i = 0; i < 30 && !(await link.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/configuracao$/)

  await page.goto('/')
  await expect(card).toBeVisible()
  await apiPost(page, '/sources', csrf, { name: 'Grupo Anuncio', telegram_chat_id: 'pa-src-2' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(card.getByRole('status')).toHaveText('Passo concluído: Conectar o Telegram.')
})

test('the empty Feed and Regras teach and act', async ({ page }) => {
  await freshInstall(page)
  await page.goto('/feed')
  await expect(page.getByText('Nenhuma regra ainda').first()).toBeVisible()
  await expect(page.getByText(/Entendi/).first()).toBeVisible()
  await page.getByRole('link', { name: 'Criar a primeira regra' }).click()
  await expect(page).toHaveURL(/\/regras$/)
  await expect(page.getByLabel(/Nome/)).toBeFocused()

  // The tip closes once and stays closed.
  await page.getByRole('button', { name: 'Entendi' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Entendi' })).toHaveCount(0)
})
