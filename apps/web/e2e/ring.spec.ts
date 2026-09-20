import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * (Named `ring` so it runs after feed.spec.ts, whose first test needs an empty feed.)
 *
 * S12-05: "Menor preço já visto" is a ring drawn ON the card's own edge — a
 * 1.5px gradient border — and nothing is painted outside the card box (the old
 * Aurora Glow was a blurred, rotating halo that spilled past it).
 */
test('the lowest-price ring paints nothing outside the card box (S12-05)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Anel',
    telegram_chat_id: '-100860',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Anel',
    include_terms: 'aneleaurora',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Anel',
    telegram_chat_id: '860',
    allowlisted: true,
  })
  for (const text of ['aneleaurora caro por R$ 300', 'aneleaurora barato por R$ 100']) {
    await apiPost(page, '/demo/messages', csrfToken, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text,
    })
  }

  await page.goto('/feed')
  await page.getByRole('button', { name: /^Regra E2E Anel/ }).click()
  const ringCard = page.locator('.match-card--aurora')
  await expect(ringCard).toHaveCount(1)
  await expect(ringCard).toContainText('aneleaurora barato por R$ 100')
  await expect(page.locator('.match-card')).toHaveCount(2)

  // ---- computed style: no blur, no shadow, no rotation, nothing outside ----
  const styles = await ringCard.evaluate((el) => {
    const read = (style: CSSStyleDeclaration) => ({
      filter: style.filter,
      boxShadow: style.boxShadow,
      backdropFilter: style.backdropFilter,
      animationName: style.animationName,
      content: style.content,
      top: style.top,
      right: style.right,
      bottom: style.bottom,
      left: style.left,
    })
    return {
      card: read(getComputedStyle(el)),
      before: read(getComputedStyle(el, '::before')),
      after: read(getComputedStyle(el, '::after')),
      borderTopWidth: getComputedStyle(el).borderTopWidth,
      radius: getComputedStyle(el).borderTopLeftRadius,
    }
  })
  for (const [name, style] of [
    ['card', styles.card],
    ['::before', styles.before],
    ['::after', styles.after],
  ] as const) {
    expect(style.filter, `${name} filter`).toBe('none')
    expect(style.boxShadow, `${name} box-shadow`).toBe('none')
    expect(style.animationName, `${name} animation`).toBe('none')
  }
  expect(styles.card.backdropFilter).toBe('none')
  expect(styles.borderTopWidth).toBe('0px')
  expect(styles.radius).toBe('18px')
  // The only pseudo-element is the ring itself, pinned to the box edges.
  expect(styles.after.content).toMatch(/^(none|normal)$/)
  expect(styles.before.content).not.toMatch(/^(none|normal)$/)
  expect([styles.before.top, styles.before.right, styles.before.bottom, styles.before.left]).toEqual([
    '0px',
    '0px',
    '0px',
    '0px',
  ])

  // ---- pixels: the 16px band around the box equals the same band without the ring ----
  await page.evaluate(() => window.scrollTo(0, 0))
  const box = await ringCard.boundingBox()
  expect(box).not.toBeNull()
  const margin = 16
  const clip = {
    x: box!.x - margin,
    y: box!.y - margin,
    width: box!.width + margin * 2,
    height: box!.height + margin * 2,
  }
  expect(clip.x).toBeGreaterThanOrEqual(0)
  expect(clip.y).toBeGreaterThanOrEqual(0)

  // Located by its text, not by the ring class the test is about to remove.
  const cardBox = page.locator('.match-card', { hasText: 'aneleaurora barato por R$ 100' })
  const shoot = () => page.screenshot({ clip, mask: [cardBox], animations: 'disabled', caret: 'hide' })
  const withRing = await shoot()

  // Same card, ring off, and its normal glass shadow off too: what remains is
  // the bare page around the box.
  await ringCard.evaluate((el) => {
    el.classList.remove('match-card--aurora')
    ;(el as HTMLElement).style.boxShadow = 'none'
  })
  const withoutRing = await shoot()

  expect(withRing.equals(withoutRing), 'pixels around the card box must be identical with and without the ring').toBe(true)
})
