import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S15-06: "Estou aplicando um filtro em Histórico, vou para Feed, volto para
// Histórico e já tenho que colocar o filtro de novo." NavCapsule always
// links to `/historico` bare (no query string), so the filters have to
// survive in sessionStorage instead — this spec drives the exact flow
// Gabriel described (filters -> Feed via the navbar -> Histórico via the
// navbar) and also an F5, and checks both the controls AND the actual
// results stay filtered, not just the selects' visual state.
//
// The scratch backend persists for the whole Playwright run (one shared
// SQLite, `fullyParallel: false`, per `feedv2.spec.ts`'s own note) — a
// random tag in every name/text (same `uniqueTag` pattern as `feedv2.spec.ts`)
// keeps this spec collision-free against earlier runs of itself
// (`--repeat-each`) or other specs' own seeds, whose rules/matches are never
// cleared between tests.
function uniqueTag(tag: string): string {
  return `${tag}-${Math.random().toString(36).slice(2, 8)}`
}

test('Histórico filters survive navigating to Feed and back via the navbar, and an F5 (S15-06)', async ({
  page,
}) => {
  const tag = uniqueTag('persist')
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: `Grupo ${tag}`,
    telegram_chat_id: `chat-${tag}`,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: `Regra ${tag}`,
    include_terms: tag,
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: `Dest ${tag}`,
    telegram_chat_id: `dest-${tag}`,
    allowlisted: true,
  })

  // Two matches under the same rule, different prices — the min-price filter
  // below has to keep excluding the cheap one after the round trip, not just
  // keep the rule filter.
  const cheapText = `${tag} barato por R$ 50`
  const expensiveText = `${tag} caro por R$ 500`
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: cheapText,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: expensiveText,
  })

  // The filter selects/inputs, scoped to the Histórico filter form itself —
  // never ambiguous with anything a page transition briefly leaves behind.
  const filterForm = page.locator('form.historico-rail')
  const historicoHeading = page.getByRole('heading', { name: 'Histórico' })

  await page.goto('/historico')
  await expect(historicoHeading).toBeVisible()
  await filterForm.getByLabel('Regra').selectOption({ label: `Regra ${tag}` })
  await filterForm.getByLabel('Preço mínimo (R$)').fill('100')
  await filterForm.getByLabel('Ordenar por').selectOption('price_desc')

  await expect(page.getByText(expensiveText)).toBeVisible()
  await expect(page.getByText(cheapText)).not.toBeVisible()

  // The flow Gabriel described: to the Feed, then back, both via the navbar
  // (never the URL bar) — NavCapsule links `/feed` and `/historico` bare.
  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await nav.getByRole('link', { name: 'Feed' }).click()
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()

  await nav.getByRole('link', { name: 'Histórico' }).click()
  // Wait for the Histórico page (and its filter form) to actually be back
  // before reading any select's value — right after the navbar click there
  // is a brief moment mid-route-transition where a value check can resolve
  // to something not yet an <input>/<select>.
  await expect(historicoHeading).toBeVisible()
  await expect(filterForm.getByLabel('Regra')).toHaveValue(String(rule.id))
  await expect(filterForm.getByLabel('Preço mínimo (R$)')).toHaveValue('100')
  await expect(filterForm.getByLabel('Ordenar por')).toHaveValue('price_desc')
  await expect(page.getByText(expensiveText)).toBeVisible()
  await expect(page.getByText(cheapText)).not.toBeVisible()

  // F5: same contract, the filters aren't just kept by never touching
  // component state (a full reload really re-reads sessionStorage).
  await page.reload()
  await expect(historicoHeading).toBeVisible()
  await expect(filterForm.getByLabel('Regra')).toHaveValue(String(rule.id))
  await expect(filterForm.getByLabel('Preço mínimo (R$)')).toHaveValue('100')
  await expect(filterForm.getByLabel('Ordenar por')).toHaveValue('price_desc')
  await expect(page.getByText(expensiveText)).toBeVisible()
  await expect(page.getByText(cheapText)).not.toBeVisible()

  // "Limpar filtros" also clears what's saved — a later visit stays empty.
  await filterForm.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(filterForm.getByLabel('Regra')).toHaveValue('')
  await expect(filterForm.getByLabel('Preço mínimo (R$)')).toHaveValue('')
  await expect(page.getByText(cheapText)).toBeVisible()

  await nav.getByRole('link', { name: 'Feed' }).click()
  await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()
  await nav.getByRole('link', { name: 'Histórico' }).click()
  await expect(historicoHeading).toBeVisible()
  await expect(filterForm.getByLabel('Regra')).toHaveValue('')
  await expect(filterForm.getByLabel('Preço mínimo (R$)')).toHaveValue('')
})
