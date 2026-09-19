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

  const card = page.getByRole('article')
  await expect(card.getByText('Promoção iPhone 15 por R$ 3.899')).toBeVisible()
  // S11-03: the Resumo rail's "Menor preço" tile shows the same real value
  // when there's only one match, so scope this to the card itself.
  await expect(card.getByText('R$ 3.899,00')).toBeVisible()
  await expect(card.getByText('Notificação desativada')).toBeVisible()
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
    .poll(() => page.locator('.historico-table__title').allTextContents())
    .toEqual([
      'gadget e2e barato por R$ 100',
      'gadget e2e medio por R$ 500',
      'gadget e2e caro por R$ 900',
    ])

  await page.getByLabel('Ordenar por').selectOption({ label: 'Maior preço primeiro' })
  await expect
    .poll(() => page.locator('.historico-table__title').allTextContents())
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
  // S10-06: cash/card price moved into one `.match-card__price` block —
  // cash as the main value, card as a smaller sub-line under it. Scoped to
  // this card specifically: the shared dev backend can already have other
  // matches' price blocks on the page from earlier tests in this file.
  const card = page.locator('.match-card', { hasText: 'gadgetduploe2e por R$ 3.899 no pix ou R$ 4.199 no cartão' })
  await expect(card.locator('.match-card__price')).toContainText('R$ 3.899,00')
  await expect(card.getByText('À vista · Cartão R$ 4.199,00')).toBeVisible()
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
  await expect(page.locator('.historico-table__title')).toHaveCount(1)
})

test('feed rail filters by rule and shows real counts, sources and a Resumo (S11-03)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Trilha',
    telegram_chat_id: '-100812',
  })
  const ruleA = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra Trilha A',
    include_terms: 'trilhaa',
  })
  const ruleB = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra Trilha B',
    include_terms: 'trilhab',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Trilha',
    telegram_chat_id: '812',
    allowlisted: true,
  })

  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: ruleA.id,
    recipient_ids: [recipient.id],
    text: 'trilhaa e2e por R$ 100',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: ruleB.id,
    recipient_ids: [recipient.id],
    text: 'trilhab e2e por R$ 200',
  })

  await page.goto('/feed')
  await expect(page.getByText('trilhaa e2e por R$ 100')).toBeVisible()
  await expect(page.getByText('trilhab e2e por R$ 200')).toBeVisible()

  const rail = page.getByRole('button', { name: /Todas as regras/ })
  await expect(rail).toBeVisible()

  // Fonte real listada na trilha, com status ativo real — escopado à
  // trilha porque o nome da fonte também aparece nos cards de match.
  const sourceRow = page.locator('.feed-rail__source', { hasText: 'Grupo E2E Trilha' })
  await expect(sourceRow).toBeVisible()
  await expect(sourceRow).toContainText('ativa')

  await page.getByRole('button', { name: /Regra Trilha A/ }).click()

  await expect(page.getByText('trilhaa e2e por R$ 100')).toBeVisible()
  await expect(page.getByText('trilhab e2e por R$ 200')).not.toBeVisible()

  const matchesTile = page.locator('.feed-summary__tile', { hasText: 'Matches' })
  await expect(matchesTile).toContainText('1')
})
