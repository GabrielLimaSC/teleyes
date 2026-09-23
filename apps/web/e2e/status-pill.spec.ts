import { expect, test } from '@playwright/test'
import { apiLogin } from './helpers'

/**
 * S12-04: the longest delivery status ("Agrupado — mesma promoção já alertada")
 * was `nowrap` and ran out of a narrow card, and at 390px out of the screen
 * (horizontal page scroll). Every status pill must stay inside its card.
 */
const api = (path: string) => (url: URL) => url.pathname === path

test('the longest status pill stays inside its card, with no horizontal scroll', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  const at = '2026-01-01T12:00:00Z'
  const statuses = ['sent', 'failed', 'historical', 'grouped', 'not_allowlisted', 'not_configured', 'duplicate', 'other']
  const matches = statuses.map((status, index) => ({
    id: index + 1,
    source_id: 1,
    rule_id: 1,
    message_text: `Produto ${status}`,
    price_cents: 100000,
    price_cash_cents: null,
    price_card_cents: null,
    message_link: null,
    matched_at: at,
    created_at: at,
    is_lowest_price_ever: false,
    grouped_source_ids: null,
    product_key: null,
    sparkline: [],
    deliveries: [{ id: index + 1, recipient_id: 1, status, delivered_at: null, created_at: at }],
  }))
  await page.route(api('/matches'), (route) => route.fulfill({ json: matches }))
  await page.route(api('/rules'), (route) => route.fulfill({ json: [] }))
  await page.route(api('/sources'), (route) => route.fulfill({ json: [] }))
  await page.route(api('/recipients'), (route) => route.fulfill({ json: [] }))

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/feed')
    await expect(page.getByText('Agrupado — mesma promoção já alertada')).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `page overflows horizontally at ${width}px`).toBeLessThanOrEqual(0)

    const escaped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.match-card__status')]
        .filter((pill) => {
          const card = pill.closest('.match-card')!.getBoundingClientRect()
          const box = pill.getBoundingClientRect()
          return box.right > card.right - 1 || box.left < card.left
        })
        .map((pill) => pill.textContent),
    )
    expect(escaped, `status pills outside their card at ${width}px`).toEqual([])
  }
})
