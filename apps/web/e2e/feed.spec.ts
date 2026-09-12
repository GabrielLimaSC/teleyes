import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const PASSWORD = 'e2e-test-password'

// `page.request` has its own cookie jar that doesn't apply the browser's
// "localhost counts as a secure context" rule the same way page fetches do,
// so a Secure session cookie set through it never sticks. Driving setup
// through page.evaluate() runs it as a real in-page fetch — same as the app
// itself — so the session cookie behaves exactly like it does for a user.
async function apiLogin(page: Page): Promise<string> {
  return page.evaluate(async (password) => {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    })
    const body = (await response.json()) as { csrf_token: string }
    return body.csrf_token
  }, PASSWORD)
}

async function apiPost<T>(page: Page, path: string, csrfToken: string, data: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, csrfToken, data }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      })
      return (await response.json()) as unknown
    },
    { path, csrfToken, data },
  ) as Promise<T>
}

test('feed shows a match live via SSE, without a page refresh', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Feed',
    telegram_chat_id: '-100777',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'iPhone E2E',
    include_terms: 'iphone',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E',
    telegram_chat_id: '999',
    allowlisted: true,
  })

  await page.goto('/feed')
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()
  await expect(page.getByText('Nenhum match ainda.')).toBeVisible()

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'Promoção iPhone 15 por R$ 3.899',
  })

  await expect(page.getByText('Promoção iPhone 15 por R$ 3.899')).toBeVisible()
  await expect(page.getByText('R$ 3.899,00')).toBeVisible()
  await expect(page.getByText('Notificação desativada')).toBeVisible()
})

test('historico filters matches by rule', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Historico',
    telegram_chat_id: '-100778',
  })
  const ruleA = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E A',
    include_terms: 'produtoa',
  })
  const ruleB = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E B',
    include_terms: 'produtob',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Historico',
    telegram_chat_id: '998',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: ruleA.id,
    recipient_ids: [recipient.id],
    text: 'produtoa e2e em oferta',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: ruleB.id,
    recipient_ids: [recipient.id],
    text: 'produtob e2e em oferta',
  })

  await page.goto('/historico')
  await expect(page.getByText('produtoa e2e em oferta')).toBeVisible()
  await expect(page.getByText('produtob e2e em oferta')).toBeVisible()

  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E A' })

  await expect(page.getByText('produtoa e2e em oferta')).toBeVisible()
  await expect(page.getByText('produtob e2e em oferta')).not.toBeVisible()
})
