import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

// S13-01: the API stores UTC; the browser must show the viewer's local time.
// Before the fix the API sent "2026-09-20T01:43:00" with no zone and the page
// read it as LOCAL, so every time came out 3h early in America/Sao_Paulo.
test.use({ timezoneId: 'America/Sao_Paulo' })

const SAO_PAULO_TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
})

test('a match is shown at its real local time, and the API states the zone (S13-01)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Fuso',
    telegram_chat_id: '-100831',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Fuso',
    include_terms: 'fusohorario',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Fuso',
    telegram_chat_id: '9831',
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'fusohorario promoção por R$ 100',
  })

  // What the API really sends: an unambiguous UTC instant.
  const apiMatches = await page.evaluate(async () => {
    const response = await fetch('/matches', { credentials: 'same-origin' })
    return (await response.json()) as Array<{ matched_at: string; created_at: string; message_text: string }>
  })
  const apiMatch = apiMatches.find((candidate) => candidate.message_text.startsWith('fusohorario'))!
  expect(apiMatch.matched_at).toMatch(/Z$/)
  expect(apiMatch.created_at).toMatch(/Z$/)

  // The same instant, rendered in America/Sao_Paulo (UTC-3), never the UTC hour.
  const localTime = SAO_PAULO_TIME.format(new Date(apiMatch.matched_at))
  const utcTime = apiMatch.matched_at.slice(11, 16)
  expect(localTime).not.toBe(utcTime)

  await page.goto('/feed')
  const card = page.getByRole('article').filter({ hasText: 'fusohorario' })
  await expect(card.locator('.match-card__timestamp')).toHaveText(`Hoje, ${localTime}`)

  await page.goto('/historico')
  const row = page.locator('.historico-table__row').filter({ hasText: 'fusohorario' })
  await expect(row.locator('.historico-table__time')).toHaveText(`Hoje, ${localTime}`)

  await page.goto('/fontes')
  const lastMatch = page.getByRole('row', { name: /Grupo E2E Fuso/ }).locator('[data-label="Último match"]')
  await expect(lastMatch).toContainText(localTime)
})
