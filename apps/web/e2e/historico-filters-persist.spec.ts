import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S15-06: "Estou aplicando um filtro em Histórico, vou para Feed, volto para
// Histórico e já tenho que colocar o filtro de novo." NavCapsule always
// links to `/historico` bare (no query string), so the filters have to
// survive in sessionStorage instead — this spec drives the exact flow
// Gabriel described (filters -> Feed via the navbar -> Histórico via the
// navbar) and also an F5, and checks both the controls AND the actual
// results stay filtered, not just the selects' visual state.
test('Histórico filters survive navigating to Feed and back via the navbar, and an F5 (S15-06)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Persist',
    telegram_chat_id: '-100840',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Persist',
    include_terms: 'persistitem',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Persist',
    telegram_chat_id: '840',
    allowlisted: true,
  })

  // Two matches under the same rule, different prices — the min-price filter
  // below has to keep excluding the cheap one after the round trip, not just
  // keep the rule filter.
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'persistitem barato por R$ 50',
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'persistitem caro por R$ 500',
  })

  await page.goto('/historico')
  await page.getByLabel('Regra').selectOption({ label: 'Regra E2E Persist' })
  await page.getByLabel('Preço mínimo (R$)').fill('100')
  await page.getByLabel('Ordenar por').selectOption('price_desc')

  await expect(page.getByText('persistitem caro por R$ 500')).toBeVisible()
  await expect(page.getByText('persistitem barato por R$ 50')).not.toBeVisible()

  // The flow Gabriel described: to the Feed, then back, both via the navbar
  // (never the URL bar) — NavCapsule links `/feed` and `/historico` bare.
  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await nav.getByRole('link', { name: 'Feed' }).click()
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()

  await nav.getByRole('link', { name: 'Histórico' }).click()
  await expect(page.getByLabel('Regra')).toHaveValue(String(rule.id))
  await expect(page.getByLabel('Preço mínimo (R$)')).toHaveValue('100')
  await expect(page.getByLabel('Ordenar por')).toHaveValue('price_desc')
  await expect(page.getByText('persistitem caro por R$ 500')).toBeVisible()
  await expect(page.getByText('persistitem barato por R$ 50')).not.toBeVisible()

  // F5: same contract, the filters aren't just kept by never touching
  // component state (a full reload really re-reads sessionStorage).
  await page.reload()
  await expect(page.getByLabel('Regra')).toHaveValue(String(rule.id))
  await expect(page.getByLabel('Preço mínimo (R$)')).toHaveValue('100')
  await expect(page.getByLabel('Ordenar por')).toHaveValue('price_desc')
  await expect(page.getByText('persistitem caro por R$ 500')).toBeVisible()
  await expect(page.getByText('persistitem barato por R$ 50')).not.toBeVisible()

  // "Limpar filtros" also clears what's saved — a later visit stays empty.
  await page.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(page.getByLabel('Regra')).toHaveValue('')
  await expect(page.getByLabel('Preço mínimo (R$)')).toHaveValue('')
  await expect(page.getByText('persistitem barato por R$ 50')).toBeVisible()

  await nav.getByRole('link', { name: 'Feed' }).click()
  await nav.getByRole('link', { name: 'Histórico' }).click()
  await expect(page.getByLabel('Regra')).toHaveValue('')
  await expect(page.getByLabel('Preço mínimo (R$)')).toHaveValue('')
})
