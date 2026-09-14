import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const

const PAGES = ['/feed', '/regras', '/fontes', '/historico', '/saude'] as const

test.describe('responsive capture (desktop + mobile, one review round)', () => {
  for (const viewport of VIEWPORTS) {
    test(`captures the login page (unauthenticated) at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      await expect(page.getByLabel('Senha')).toBeVisible()
      const mascot = page.getByRole('button', { name: 'Expandir navegação' })
      const mascotBox = await mascot.boundingBox()
      expect(mascotBox).not.toBeNull()
      expect(Math.abs(mascotBox!.x + mascotBox!.width / 2 - viewport.width / 2)).toBeLessThan(1)
      await expect(page.locator('.nav-capsule__glass')).toHaveCSS('opacity', '0')

      await mascot.click()
      await expect(page.getByRole('button', { name: 'Recolher navegação' })).toBeVisible()
      await expect(page.locator('.nav-capsule__glass')).toHaveCSS('opacity', '1')
      for (const label of ['Login', 'Feed', 'Regras', 'Fontes', 'Histórico', 'Saúde']) {
        await expect(page.getByRole('link', { name: label })).toBeVisible()
      }
      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ])
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
      await page.screenshot({
        path: `test-results/responsive/${viewport.name}-login.png`,
        fullPage: true,
      })
    })
  }

  for (const viewport of VIEWPORTS) {
    test(`captures every authenticated page at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      const csrfToken = await apiLogin(page)

      // Seed one real match with realistic-looking content (not placeholder
      // fixture names) so Feed/Histórico/Regras/Fontes read as the real
      // product would, not as leftover test data — matters for anyone
      // reviewing these captures as design evidence, not just for the test.
      const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
        name: 'Urubu das Promoções',
        telegram_chat_id: `-100${viewport.name === 'desktop' ? 601 : 602}`,
      })
      const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
        name: 'iPhone até R$ 5.000',
        include_terms: 'iphone',
        max_price_cents: 500_000,
      })
      const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
        name: 'Gabriel',
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
        // wait past the initial "Carregando…" so the capture shows real
        // content, not a timing artifact of screenshotting too fast — /regras
        // renders two independent loading sections (Regras + Destinatários),
        // so count-based waiting instead of a single-element assertion
        await expect(page.getByText('Carregando…')).toHaveCount(0)
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
