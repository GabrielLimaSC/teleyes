import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S17-10: "atingido" só vale para oferta das últimas 24 h, e o status do
 * trilho "Alvos de preço" ("falta 14%", "atingido") fica em UMA linha mesmo
 * com nome de regra longo — o nome é que quebra. Backend real; as ofertas são
 * semeadas agora (dentro da janela). A regra sem oferta nas últimas 24 h é
 * uma regra com alvo e nenhum match: nunca "atingido".
 */
const SHOTS = process.env.S1710_SHOTS_DIR

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`alvos ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('status do alvo em uma linha, estados atingido/falta/sem oferta', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto('/')
      const csrf = await apiLogin(page)
      const tag = Math.random().toString(36).slice(2, 8)
      const source = await apiPost<{ id: number }>(page, '/sources', csrf, {
        name: `Fonte ${tag}`,
        telegram_chat_id: `c-${tag}`,
      })
      const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
        name: `Dest ${tag}`,
        telegram_chat_id: `d-${tag}`,
        allowlisted: true,
      })
      const gapName = `AMD Ryzen 7 9800X3D ${tag}`
      const hitName = `PLACA-MAE B850M AYW GAMING WIFI ${tag}`
      const noneName = `Sem oferta recente ${tag}`
      const gapRule = await apiPost<{ id: number }>(page, '/rules', csrf, {
        name: gapName,
        include_terms: `gap${tag}`,
        target_price_cents: 200_000,
      })
      const hitRule = await apiPost<{ id: number }>(page, '/rules', csrf, {
        name: hitName,
        include_terms: `hit${tag}`,
        target_price_cents: 150_000,
      })
      await apiPost(page, '/rules', csrf, { name: noneName, include_terms: `none${tag}`, target_price_cents: 100_000 })
      for (const [rule, word, price] of [
        [gapRule, 'gap', '2.320,00'],
        [hitRule, 'hit', '1.399,00'],
      ] as const) {
        await apiPost(page, '/demo/messages', csrf, {
          source_id: source.id,
          rule_id: rule.id,
          recipient_ids: [recipient.id],
          text: `Produto ${word}${tag} por R$ ${price}`,
        })
      }

      await page.goto('/feed')
      const rows = {
        gap: page.locator('.feed-target', { hasText: gapName }),
        hit: page.locator('.feed-target', { hasText: hitName }),
        none: page.locator('.feed-target', { hasText: noneName }),
      }
      for (const row of Object.values(rows)) await expect(row).toBeVisible()
      await expect(rows.gap.locator('.feed-target__status')).toHaveText('falta 16%')
      await expect(rows.hit.locator('.feed-target__status')).toHaveText('atingido')
      await expect(rows.none.locator('.feed-target__status')).toHaveText('sem oferta')
      await expect(rows.none.locator('.feed-target__status--hit')).toHaveCount(0)
      await expect(rows.none).not.toContainText('atingido')

      // One line: the status box is no taller than ~1.4 lines, and the long
      // name wraps instead (taller than the status).
      for (const row of Object.values(rows)) {
        const metrics = await row.evaluate((element) => {
          const status = element.querySelector('.feed-target__status') as HTMLElement
          const name = element.querySelector('.feed-target__name') as HTMLElement
          const lineHeight = parseFloat(getComputedStyle(status).lineHeight) || parseFloat(getComputedStyle(status).fontSize) * 1.4
          return { statusHeight: status.getBoundingClientRect().height, nameHeight: name.getBoundingClientRect().height, lineHeight }
        })
        expect(metrics.statusHeight).toBeLessThan(metrics.lineHeight * 1.5)
        void metrics.nameHeight
      }
      const longName = await rows.hit.locator('.feed-target__name').boundingBox()
      const hitStatus = await rows.hit.locator('.feed-target__status').boundingBox()
      expect(longName!.height).toBeGreaterThan(hitStatus!.height * 1.5) // the name wrapped, the status did not

      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true })
        await page.locator('#feed-rail-left').screenshot({ path: path.join(SHOTS, `feed-rail-${scheme}.png`) })
      }

      // Regras: same three states in the "Alvo" column.
      await page.goto('/regras')
      const cell = (name: string) =>
        page.locator('tr', { has: page.getByText(name, { exact: true }) }).locator('[data-label="Alvo"]')
      await expect(cell(hitName)).toContainText('atingido')
      await expect(cell(gapName)).toContainText('falta 16%')
      await expect(cell(noneName)).toContainText('sem oferta nas últimas 24 h')
      await expect(cell(noneName)).not.toContainText('atingido')
      if (SHOTS) {
        await page.locator('.wide-table-wrap').first().screenshot({ path: path.join(SHOTS, `regras-${scheme}.png`) })
      }
    })
  })
}
