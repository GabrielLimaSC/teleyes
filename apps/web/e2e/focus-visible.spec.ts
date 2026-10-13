import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S12-04: keyboard focus is visible on EVERY control of every screen, in both
 * themes. Tabs through each page and, for each stop, compares the element's
 * paint (outline, box-shadow, border colour, background) with the same element
 * after it loses focus: a stop that looks identical focused and unfocused has
 * no visible focus. Reports the stops that fail with a readable name.
 */
const THEMES = ['light', 'dark'] as const
const ROUTES = ['/', '/feed', '/historico', '/regras', '/fontes', '/saude'] as const
const MAX_STOPS = 120

for (const theme of THEMES) {
  test(`every tab stop of every screen shows a focus indicator (${theme})`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/')
    const csrf = await apiLogin(page)
    // A little data so the row actions, cards and tables have stops of their own.
    const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Fonte foco ${theme}`, telegram_chat_id: `-1009${theme === 'dark' ? 1 : 2}` })
    const rule = await apiPost<{ id: number }>(page, '/rules', csrf, { name: `Regra foco ${theme}`, include_terms: 'foco' })
    const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, { name: `Gabriel foco ${theme}`, telegram_chat_id: `9${theme === 'dark' ? 1 : 2}`, allowlisted: true })
    await apiPost(page, '/demo/messages', csrf, { source_id: source.id, rule_id: rule.id, recipient_ids: [recipient.id], text: `foco notebook por R$ 2.999 ${theme}`, link: 'https://t.me/c/1/2' })
    await apiPost(page, '/demo/messages', csrf, { source_id: source.id, rule_id: rule.id, recipient_ids: [recipient.id], text: `foco fone por R$ 199 ${theme}` })

    const invisible: string[] = []
    let stops = 0
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const route of ROUTES) {
        await page.goto(route)
        await expect(page.locator('main, form').first()).toBeVisible()
        // No transitions: a style read right after the blur must be the final one.
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
        await page.waitForTimeout(400)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        for (let stop = 0; stop < MAX_STOPS; stop += 1) {
          await page.keyboard.press('Tab')
          const result = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null
            if (el === null || el === document.body) return null
            const paint = () => {
              const style = getComputedStyle(el)
              return [
                style.outlineStyle === 'none' ? 'none' : `${style.outlineWidth} ${style.outlineColor}`,
                style.boxShadow,
                style.borderTopColor,
                style.backgroundColor,
                style.backgroundImage,
                style.color,
                style.textDecorationLine,
                style.opacity,
              ].join('|')
            }
            const focused = paint()
            const focusedParent = el.parentElement ? getComputedStyle(el.parentElement).boxShadow : ''
            const name =
              `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}` +
              ` "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`
            const wraps = el.closest('label, .term-chips, .tooltip')
            const wrapPaint = wraps ? getComputedStyle(wraps).boxShadow + getComputedStyle(wraps).borderTopColor : ''
            // Hover/transition noise: read again after the element is blurred.
            el.blur()
            const unfocused = paint()
            const wrapAfter = wraps ? getComputedStyle(wraps).boxShadow + getComputedStyle(wraps).borderTopColor : ''
            el.focus({ focusVisible: true } as FocusOptions)
            return { name, changed: focused !== unfocused || wrapPaint !== wrapAfter, focusedParent }
          })
          if (result === null) break
          stops += 1
          if (!result.changed) invisible.push(`${theme} ${width}px ${route}: ${result.name}`)
        }
      }
    }
    // The walk really visited the screens' controls (a broken Tab walk would pass vacuously).
    expect(stops).toBeGreaterThan(100)
    expect(invisible, 'tab stops with no visible focus indicator').toEqual([])
  })
}
