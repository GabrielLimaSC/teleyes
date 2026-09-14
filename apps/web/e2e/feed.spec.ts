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

test('historico sorts matches by price within a rule (S7-07)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Ranking',
    telegram_chat_id: '-100780',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Ranking',
    include_terms: 'gadget e2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Ranking',
    telegram_chat_id: '993',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadget e2e caro por R$ 900',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadget e2e barato por R$ 100',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadget e2e medio por R$ 500',
  })

  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Ranking' })
  await expect(page.getByText('gadget e2e caro por R$ 900')).toBeVisible()

  await page.getByLabel('Ordenar por').selectOption({ label: 'Menor preço primeiro' })
  await expect
    .poll(() => page.locator('.match-card__product').allTextContents())
    .toEqual([
      'gadget e2e barato por R$ 100',
      'gadget e2e medio por R$ 500',
      'gadget e2e caro por R$ 900',
    ])

  await page.getByLabel('Ordenar por').selectOption({ label: 'Maior preço primeiro' })
  await expect
    .poll(() => page.locator('.match-card__product').allTextContents())
    .toEqual([
      'gadget e2e caro por R$ 900',
      'gadget e2e medio por R$ 500',
      'gadget e2e barato por R$ 100',
    ])
})

test('the feed shows both prices when the message anchors cash and card explicitly (S7-05)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Preco Duplo',
    telegram_chat_id: '-100782',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Preco Duplo',
    include_terms: 'gadgetduploe2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Preco Duplo',
    telegram_chat_id: '991',
    allowlisted: true,
  })

  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetduploe2e por R$ 3.899 no pix ou R$ 4.199 no cartão',
  })

  await expect(page.getByText('gadgetduploe2e por R$ 3.899 no pix ou R$ 4.199 no cartão')).toBeVisible()
  await expect(page.getByText('À vista: R$ 3.899,00')).toBeVisible()
  await expect(page.getByText('Cartão: R$ 4.199,00')).toBeVisible()
})

test('two sources posting the exact same promotion collapse into one card (S7-11)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const sourceA = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Duplicado A',
    telegram_chat_id: '-100790',
  })
  const sourceB = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Duplicado B',
    telegram_chat_id: '-100791',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Duplicado',
    include_terms: 'gadgetdupe2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Duplicado',
    telegram_chat_id: '990',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: sourceA.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetdupe2e por R$ 4.000 no Grupo A',
  })
  // Same rule, same price, posted seconds later from a different source —
  // well within GROUPING_WINDOW.
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: sourceB.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetdupe2e por R$ 4.000 no Grupo B',
  })

  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Duplicado' })

  // Only the first source's card stays, now naming the other source too —
  // the second message is a real, persisted Match (never lost, S6-01), just
  // never its own card and never its own alert.
  await expect(page.getByText('gadgetdupe2e por R$ 4.000 no Grupo A')).toBeVisible()
  await expect(page.getByText('Visto em: Grupo E2E Duplicado B')).toBeVisible()
  await expect(page.getByText('gadgetdupe2e por R$ 4.000 no Grupo B')).not.toBeVisible()
  await expect(page.locator('.match-card__product')).toHaveCount(1)
})
