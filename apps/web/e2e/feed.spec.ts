import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

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
