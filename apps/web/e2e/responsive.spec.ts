import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const

const PAGES = ['/feed', '/regras', '/fontes', '/historico', '/saude'] as const

test.describe('responsive capture (desktop + mobile, one review round)', () => {
  for (const viewport of VIEWPORTS) {
    test(`captures every authenticated page at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      const csrfToken = await apiLogin(page)

      // seed one real match so Feed/Histórico aren't only the empty state
      const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
        name: `Grupo Responsive ${viewport.name}`,
        telegram_chat_id: `-100${viewport.name === 'desktop' ? 601 : 602}`,
      })
      const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
        name: `Regra Responsive ${viewport.name}`,
        include_terms: 'iphone',
        max_price_cents: 500_000,
      })
      const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
        name: `Destinatario Responsive ${viewport.name}`,
        telegram_chat_id: viewport.name === 'desktop' ? '901' : '902',
        allowlisted: true,
      })
      await apiPost(page, '/demo/messages', csrfToken, {
        source_id: source.id,
        rule_id: rule.id,
        recipient_ids: [recipient.id],
        text: 'Promoção iPhone 15 por R$ 3.899',
      })

      for (const path of PAGES) {
        await page.goto(path)
        await expect(page.locator('main')).toBeVisible()
        // the page body must never scroll horizontally at either width
        const [scrollWidth, clientWidth] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ])
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)

        await page.screenshot({
          path: `test-results/responsive/${viewport.name}${path.replace(/\//g, '-')}.png`,
          fullPage: true,
        })
      }
    })
  }
})
