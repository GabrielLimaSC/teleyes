import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

test('feed and historico show the empty state before any match exists', async ({ page }) => {
  // Other spec files share this backend and may have already created
  // matches — intercept /matches so this checks the real EmptyState render
  // path deterministically, regardless of run order.
  await page.route(/\/matches(\?.*)?$/, (route) => route.fulfill({ json: [] }))
  await page.goto('/')
  await apiLogin(page)

  await page.goto('/feed')
  await expect(page.getByText('Nenhum match ainda.')).toBeVisible()

  await page.goto('/historico')
  await expect(page.getByText('Nenhum match encontrado com esses filtros.')).toBeVisible()
})

test('a message with no extractable price shows the honest placeholder, live', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo Sem Preco E2E',
    telegram_chat_id: '-100888',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Fritadeira E2E',
    include_terms: 'air fryer',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel Sem Preco E2E',
    telegram_chat_id: '996',
    allowlisted: true,
  })

  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'Air fryer nova chegou na loja',
  })

  // Scoped to this match's own card — the shared backend may hold other
  // priceless matches from other spec files.
  const card = page.locator('.match-card', { hasText: 'Air fryer nova chegou na loja' })
  await expect(card).toBeVisible()
  await expect(card.getByText('Preço não identificado')).toBeVisible()
})

test('shows an offline banner when the browser goes offline, and clears it back online', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  await expect(page.getByRole('status').filter({ hasText: 'offline' })).not.toBeVisible()

  await context.setOffline(true)
  await expect(page.getByRole('status').filter({ hasText: 'Você está offline' })).toBeVisible()

  await context.setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: 'Você está offline' })).not.toBeVisible()
})

test('the nav capsule is fully reachable by keyboard with visible focus', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const feedLink = page.getByRole('link', { name: 'Feed' })
  await feedLink.focus()
  await expect(feedLink).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Regras' })).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/regras')
})

test('respects prefers-reduced-motion: the nav pill transition is disabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const transition = await page.locator('.nav-pill').evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(transition).toMatch(/^0s(,\s*0s)*$/)
})
