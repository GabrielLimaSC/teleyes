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

test('the "Abrir promoção" button opens the real link in a new tab (S7-10)', async ({
  page,
  context,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Link',
    telegram_chat_id: '-100781',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Link',
    include_terms: 'gadgetlinke2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Link',
    telegram_chat_id: '992',
    allowlisted: true,
  })

  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetlinke2e por R$ 100',
    link: 'https://t.me/c/123456/99',
  })

  const openButton = page.getByRole('link', { name: 'Abrir promoção' })
  await expect(openButton).toBeVisible()
  await expect(openButton).toHaveAttribute('href', 'https://t.me/c/123456/99')
  await expect(openButton).toHaveAttribute('target', '_blank')

  // Real Telegram link — fulfilled with an empty stub instead of aborted, so
  // the tab actually finishes navigating there (and newPage.url() reflects
  // the real target) without this test depending on the real t.me network.
  await context.route('https://t.me/**', (route) => route.fulfill({ status: 200, body: '' }))
  const [newPage] = await Promise.all([context.waitForEvent('page'), openButton.click()])
  await newPage.waitForLoadState('load')
  expect(newPage.url()).toBe('https://t.me/c/123456/99')
  await newPage.close()
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

test('a long product name wraps instead of being cut with an ellipsis (S7-02)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo Nome Longo E2E',
    telegram_chat_id: '-100779',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'RTX E2E',
    include_terms: 'rtx',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel Nome Longo E2E',
    telegram_chat_id: '994',
    allowlisted: true,
  })
  const longText =
    'Placa de vídeo rtx 5060 Ti 16GB GDDR7 com resfriamento triplo e RGB endereçável, ' +
    'edição especial gamer completa da linha, frete grátis pra todo o Brasil'

  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: longText,
  })

  const product = page.locator('.match-card__product', { hasText: 'rtx 5060 Ti' })
  await expect(product).toBeVisible()

  const style = await product.evaluate((el) => {
    const computed = getComputedStyle(el)
    return { whiteSpace: computed.whiteSpace, textOverflow: computed.textOverflow }
  })
  expect(style.whiteSpace).not.toBe('nowrap')
  expect(style.textOverflow).not.toBe('ellipsis')

  // The full text is really on screen, not just present-but-clipped in the
  // DOM: a wrapped element's rendered box is taller than a single line of
  // text at this font size — `lineHeight` itself is unreliable to compare
  // against directly, since this element never sets one explicitly and
  // Chromium reports the computed `normal` keyword, not a pixel value.
  const box = await product.boundingBox()
  const fontSize = await product.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(box!.height).toBeGreaterThan(fontSize * 1.8)
})

test('a real promo message with links and a footer shows only the text before the link (S8-02)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'CMdias E2E',
    telegram_chat_id: '-100783',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'RTX 5070 E2E',
    include_terms: 'rtx 5070',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E CMdias',
    telegram_chat_id: '995',
    allowlisted: true,
  })
  // The exact real message that made the card enormous in the homologation
  // (also the S8-01 fixture for the coupon-price bug — same message, two
  // different bugs).
  const realText =
    '🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF: ' +
    'https://s.shopee.com.br/abc ⚠️Cupom, preço e estoque por tempo limitado. Anúncio'

  await page.goto('/feed')
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: realText,
  })

  await expect(
    page.getByText('🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF:'),
  ).toBeVisible()
  await expect(page.getByText(/shopee\.com\.br/)).not.toBeVisible()
  await expect(page.getByText(/Anúncio/)).not.toBeVisible()
})

test('the "Atualizar" button reloads Feed and Histórico on demand, no F5 needed (S7-02)', async ({
  page,
}) => {
  await page.goto('/')
  await apiLogin(page)

  await page.goto('/feed')
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeVisible()
  const [feedResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/matches') && res.request().method() === 'GET'),
    page.getByRole('button', { name: 'Atualizar' }).click(),
  ])
  expect(feedResponse.ok()).toBe(true)

  await page.goto('/historico')
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeVisible()
  const [historicoResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/matches') && res.request().method() === 'GET'),
    page.getByRole('button', { name: 'Atualizar' }).click(),
  ])
  expect(historicoResponse.ok()).toBe(true)
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

  const labels = ['Login', 'Feed', 'Regras', 'Fontes', 'Histórico', 'Saúde']
  const loginLink = page.getByRole('link', { name: 'Login' })
  await loginLink.focus()
  await expect(loginLink).toBeFocused()
  await expect(page.locator('.nav-capsule__glass')).toHaveCSS('opacity', '1')

  for (const label of labels.slice(1)) {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: label })).toBeFocused()
  }

  await page.getByRole('link', { name: 'Regras' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/regras')
})

test('respects prefers-reduced-motion: the nav expansion transition is disabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  for (const selector of ['.nav-capsule__glass', '.nav-capsule__wing', '.nav-mascot']) {
    const transition = await page.locator(selector).first().evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(transition).toMatch(/^0s(,\s*0s)*$/)
  }
})
