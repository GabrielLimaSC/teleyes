import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { E2E_PASSWORD } from '../e2e/helpers'

// S19-02: the whole setup wizard in a browser, against the REAL api with a FAKE Telegram and
// bot (e2e-setup/e2e_setup_app.py). The fake accepts the login code 13579 and any bot token
// that does not contain "INVALID". Nothing here reaches the network; what the real Telegram
// does is covered by docs/SETUP_MANUAL_VALIDATION.md.

const API_ID = '1234567'
const API_HASH = '0123456789abcdef0123456789abcdef'
const PHONE = '+5511999998888'
const CODE = '13579'
const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_x1'

// The e2e-only helpers live on the backend itself (not behind the dev proxy).
const BACKEND = 'http://127.0.0.1:8199'

async function e2e(page: Page, path: string, data?: unknown) {
  const response = await page.request.post(`${BACKEND}/__e2e/${path}`, { data })
  expect(response.ok()).toBe(true)
}

/** A GET from inside the page, so it carries the session cookie. */
async function getJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => (await (await fetch(url, { credentials: 'same-origin' })).json()) as unknown, path) as Promise<T>
}

async function reset(page: Page): Promise<void> {
  await e2e(page, 'reset')
}

async function login(page: Page): Promise<string> {
  await page.goto('/')
  return page.evaluate(async (password) => {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    })
    const body = (await response.json()) as { csrf_token: string }
    sessionStorage.setItem('teleyes.csrf_token', body.csrf_token)
    return body.csrf_token
  }, E2E_PASSWORD)
}

/** A call to the real API from the page (session cookie + CSRF), used to jump ahead. */
async function api(page: Page, csrf: string, method: string, path: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ method, path, body, csrf }) => {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`)
      return response.status === 204 ? null : await response.json()
    },
    { method, path, body, csrf },
  )
}

async function seedCredentials(page: Page, csrf: string) {
  await api(page, csrf, 'PUT', '/setup/credentials', { api_id: Number(API_ID), api_hash: API_HASH })
}
async function seedLogin(page: Page, csrf: string) {
  await seedCredentials(page, csrf)
  await api(page, csrf, 'POST', '/setup/telegram/login/start', { phone: PHONE })
  await api(page, csrf, 'POST', '/setup/telegram/login/code', { code: CODE })
}
async function seedBot(page: Page, csrf: string) {
  await seedLogin(page, csrf)
  await api(page, csrf, 'PUT', '/setup/bot', { token: TOKEN })
  await api(page, csrf, 'POST', '/recipients', { name: 'Gabriel', telegram_chat_id: '5550001', allowlisted: true })
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0)
}

const step = (page: Page, name: RegExp | string) => page.getByRole('button', { name, expanded: true })

test.describe('wizard', () => {
  test.beforeEach(async ({ page }) => {
    await reset(page)
  })

  test('walks the whole wizard: credentials, login with 2FA, bot, pairing, groups, rule, all ready', async ({
    page,
  }) => {
    await e2e(page, 'two-factor')
    await login(page)

    // The call to action on the Feed leads to the wizard.
    await page.goto('/feed')
    const banner = page.getByRole('complementary', { name: 'Configuração pendente' })
    await expect(banner).toBeVisible()
    await banner.getByRole('link', { name: 'Configurar o Telegram' }).click()
    await expect(page).toHaveURL(/\/configuracao$/)

    // 1. credentials (a bad api_hash is stopped before the server).
    await expect(step(page, /Credenciais do aplicativo Telegram/)).toBeVisible()
    await page.getByLabel('api_id').fill(API_ID)
    await page.getByLabel('api_hash').fill('curto')
    await page.getByRole('button', { name: 'Salvar credenciais' }).click()
    await expect(page.getByRole('alert')).toContainText('32 caracteres')
    await page.getByLabel('api_hash').fill(API_HASH)
    await page.getByRole('button', { name: 'Salvar credenciais' }).click()

    // 2. Telegram account: format error, wrong code, reload mid-login, right code, 2FA.
    await expect(step(page, /Conta do Telegram/)).toBeVisible()
    await expect(page.getByText(/acesso total à conta do Telegram/)).toBeVisible()
    await page.getByLabel(/Telefone/).fill('11999998888')
    await page.getByRole('button', { name: /Enviar código/ }).click()
    await expect(page.getByRole('alert')).toContainText('Comece com +')
    await page.getByLabel(/Telefone/).fill(PHONE)
    await page.getByRole('button', { name: /Enviar código/ }).click()
    await expect(page.getByText('+55•••••••8888')).toBeVisible()

    await page.getByLabel('Código').fill('00000')
    await page.getByRole('button', { name: /Confirmar código/ }).click()
    await expect(page.getByRole('alert')).toContainText('Código incorreto')

    await page.reload() // closing the tab must not lose the login: the server remembers
    await expect(page.getByText('+55•••••••8888')).toBeVisible()
    await page.getByLabel('Código').fill(CODE)
    await page.getByRole('button', { name: /Confirmar código/ }).click()

    await expect(page.getByLabel(/Senha da verificação/)).toBeVisible()
    await page.getByLabel(/Senha da verificação/).fill('errada')
    await page.getByRole('button', { name: /Entrar/ }).click()
    await expect(page.getByRole('alert')).toContainText('duas etapas incorreta')
    await expect(page.getByLabel(/Senha da verificação/)).toHaveValue('')
    await page.getByLabel(/Senha da verificação/).fill('e2e-2fa-password')
    await page.getByRole('button', { name: /Entrar/ }).click()

    // 3. bot: an unknown token, then a good one; pairing through the deep link.
    await expect(step(page, /Bot de alertas/)).toBeVisible()
    await page.getByLabel('Token do bot').fill('123456789:INVALIDINVALIDINVALIDINVALIDINVALID')
    await page.getByRole('button', { name: 'Validar token' }).click()
    await expect(page.getByRole('alert')).toContainText('não reconheceu')
    await page.getByLabel('Token do bot').fill(TOKEN)
    await page.getByRole('button', { name: 'Validar token' }).click()
    await expect(page.getByRole('link', { name: '@teleyes_e2e_bot' })).toBeVisible()

    await page.getByRole('button', { name: 'Gerar link de pareamento' }).click()
    const deepLink = page.getByRole('link', { name: /Abrir @teleyes_e2e_bot no Telegram/ })
    const href = (await deepLink.getAttribute('href')) ?? ''
    expect(href).toMatch(/^https:\/\/t\.me\/teleyes_e2e_bot\?start=[\w-]+$/)
    const code = new URL(href).searchParams.get('start') ?? ''

    // A stranger tapping Start without the code is ignored...
    await e2e(page, 'start', { code: '', chat_id: '666', name: 'Intruso' })
    await expect(page.getByText(/sem o código do link, e ignorei/)).toBeVisible()
    // ...the person who has the link is registered.
    await e2e(page, 'start', { code, chat_id: '5550001', name: 'Gabriel E2E' })
    await expect(page.getByText(/Gabriel E2E cadastrado/)).toBeVisible()
    const name = page.getByLabel('Nome do destinatário')
    await name.fill('Gabriel')
    await name.blur()
    await expect(name).toHaveValue('Gabriel')
    await page.getByRole('button', { name: 'Enviar mensagem de teste' }).click()
    await expect(page.getByText(/Mensagem de teste entregue/)).toBeVisible()
    const sent = (await (await page.request.get(`${BACKEND}/__e2e/sent`)).json()) as string[][]
    expect(sent.map(([chat]) => chat)).toEqual(['5550001'])

    // The stranger was never registered.
    const recipients = await getJson<{ telegram_chat_id: string }[]>(page, '/recipients')
    expect(recipients.map((r) => r.telegram_chat_id)).toEqual(['5550001'])

    // 4. groups: read-only listing, pick two.
    await page.getByRole('button', { name: /Grupos para monitorar/ }).click()
    await expect(page.getByText(/nunca entra em grupos, responde, reage nem encaminha/)).toBeVisible()
    await page.getByRole('button', { name: 'Buscar meus grupos' }).click()
    await expect(page.getByRole('checkbox', { name: /Promoções de Hardware/ })).toBeVisible()
    await expect(page.getByText('Maria (conversa privada)')).toHaveCount(0)
    await page.getByRole('checkbox', { name: /Promoções de Hardware/ }).check()
    await page.getByRole('checkbox', { name: /Black Friday BR/ }).check()
    await page.getByRole('button', { name: 'Monitorar 2 selecionado(s)' }).click()
    await expect(page.getByText(/2 grupo\(s\) adicionado\(s\)/)).toBeVisible()

    // 5. first rule from a template, applied.
    await page.getByRole('button', { name: /Primeira regra/ }).click()
    await page.getByRole('button', { name: 'Placa de vídeo RTX 5070' }).click()
    await page.getByLabel(/Preço máximo/).fill('4.500')
    await page.getByRole('button', { name: 'Criar regra e aplicar' }).click()
    await expect(page.getByText(/criada e enviada ao monitor/)).toBeVisible()
    const reload = await getJson<{ state: string }>(page, '/listener/status')
    expect(reload.state).toBe('pending')

    // 6. everything ready, with the live checks (the e2e backend plays the listener).
    await page.getByRole('button', { name: /Tudo pronto\?/ }).click()
    await expect(page.getByText(/Tudo pronto\./)).toBeVisible()
    const checks = page.getByRole('list', { name: 'Verificação ao vivo' })
    await expect(checks.getByText(/Monitor conectado — ok/)).toBeVisible()
    await expect(checks.getByText(/Bot de alertas — ok/)).toBeVisible()
    await expect(checks.getByText(/Grupos monitorados — ok/)).toBeVisible()
    await expect(checks.getByText(/Regras ativas — ok/)).toBeVisible()

    // The banner is gone from the Feed, and the way back is on Saúde.
    await page.goto('/feed')
    await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Configuração pendente' })).toHaveCount(0)
    await page.goto('/saude')
    await expect(page.getByRole('link', { name: /Abrir o assistente de configuração/ })).toBeVisible()
  })

  test('shows how long to wait when Telegram asks for a flood wait', async ({ page }) => {
    const csrf = await login(page)
    await seedCredentials(page, csrf)
    await e2e(page, 'flood', { seconds: 754 })
    await page.goto('/configuracao')

    await page.getByLabel(/Telefone/).fill(PHONE)
    await page.getByRole('button', { name: /Enviar código/ }).click()

    await expect(page.getByRole('alert')).toContainText('13 minutos')
    await expect(page.getByRole('button', { name: /aguarde/ })).toBeDisabled()
  })

  test('disconnect asks for confirmation, wipes the session and restarts the wizard', async ({ page }) => {
    const csrf = await login(page)
    await seedBot(page, csrf)
    await page.goto('/configuracao')

    await page.getByRole('button', { name: /Conta do Telegram/ }).click()
    await page.getByRole('button', { name: 'Desconectar Telegram' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click()
    expect((await getJson<{ steps: { login: boolean } }>(page, '/setup/status')).steps.login).toBe(true)

    await page.getByRole('button', { name: 'Desconectar Telegram' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Desconectar' }).click()

    await expect(page.getByLabel('api_hash')).toBeVisible()
    const status = await getJson<{ steps: { credentials: boolean; login: boolean; bot: boolean } }>(page, '/setup/status')
    expect(status.steps).toMatchObject({ credentials: false, login: false, bot: false })
    await page.goto('/feed')
    await expect(page.getByRole('complementary', { name: 'Configuração pendente' })).toBeVisible()
  })

  test('the API never returns a secret during the whole flow', async ({ page }) => {
    const csrf = await login(page)
    await seedBot(page, csrf)
    const bodies: string[] = []
    page.on('response', async (response) => {
      if (response.url().includes('/setup/')) bodies.push(await response.text().catch(() => ''))
    })
    await page.goto('/configuracao')
    await expect(page.getByRole('button', { name: /Bot de alertas/ })).toBeVisible()
    await page.waitForTimeout(500)

    const all = bodies.join('\n')
    expect(all.length).toBeGreaterThan(0)
    for (const secret of [API_HASH, TOKEN, CODE, PHONE]) expect(all).not.toContain(secret)
    expect(await page.content()).not.toContain(API_HASH)
    expect(await page.content()).not.toContain(TOKEN)
  })
})

// Layout and theme: every step, in both themes, at desktop and phone width, without a
// horizontal scrollbar.
for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile 390px', width: 390, height: 844 },
  ]) {
    test.describe(`${scheme} / ${viewport.name}`, () => {
      test.use({ colorScheme: scheme, viewport: { width: viewport.width, height: viewport.height } })

      test('no horizontal scroll on any step, and the primary action is reachable', async ({ page }) => {
        await reset(page)
        const csrf = await login(page)
        await page.goto('/configuracao')
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)

        const open = async (title: RegExp) => {
          const header = page.getByRole('button', { name: title })
          if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
          await noHorizontalScroll(page)
        }

        await open(/Credenciais do aplicativo Telegram/)
        await expect(page.getByRole('button', { name: 'Salvar credenciais' })).toBeVisible()
        await seedCredentials(page, csrf)
        await page.reload()
        await open(/Conta do Telegram/)
        await expect(page.getByRole('button', { name: /Enviar código/ })).toBeVisible()
        await api(page, csrf, 'POST', '/setup/telegram/login/start', { phone: PHONE })
        await page.reload()
        await expect(page.getByRole('button', { name: /Confirmar código/ })).toBeVisible()
        await noHorizontalScroll(page)
        await api(page, csrf, 'POST', '/setup/telegram/login/code', { code: CODE })
        await page.reload()
        await open(/Bot de alertas/)
        await expect(page.getByRole('button', { name: 'Validar token' })).toBeVisible()
        await api(page, csrf, 'PUT', '/setup/bot', { token: TOKEN })
        await api(page, csrf, 'POST', '/setup/bot/pairing')
        await page.reload()
        await open(/Bot de alertas/)
        await expect(page.getByText(/Aguardando o \/start/)).toBeVisible()
        await api(page, csrf, 'POST', '/recipients', { name: 'Gabriel', telegram_chat_id: '5550001', allowlisted: true })
        await page.reload()
        await open(/Grupos para monitorar/)
        await page.getByRole('button', { name: 'Buscar meus grupos' }).click()
        await expect(page.getByRole('checkbox', { name: /Black Friday BR/ })).toBeVisible()
        await noHorizontalScroll(page)
        await api(page, csrf, 'POST', '/setup/groups/select', { chat_ids: ['-1001'] })
        await page.reload()
        await open(/Primeira regra/)
        await page.getByRole('button', { name: 'Regra livre' }).click()
        await noHorizontalScroll(page)
        await open(/Tudo pronto\?/)

        await page.goto('/feed')
        await noHorizontalScroll(page)
        await expect(page.getByRole('complementary', { name: 'Configuração pendente' })).toBeVisible()
        await noHorizontalScroll(page)
        await page.goto('/saude')
        await noHorizontalScroll(page)
      })
    })
  }
}
