import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S18-01: pausar e reativar uma regra, e as ações da linha reorganizadas.
 * Real backend; tag aleatória porque o backend é compartilhado. Com
 * `S18_SHOTS=<dir>` também grava as capturas (fora do repositório).
 */
const SHOTS_DIR = process.env.S18_SHOTS

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

async function expectNoHorizontalOverflow(page: Page) {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ])
  expect(scrollWidth, 'sem rolagem horizontal da página').toBeLessThanOrEqual(clientWidth)
}

async function shoot(page: Page, name: string) {
  if (!SHOTS_DIR) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) })
}

/** Left edge once the layout has settled (async fills — history, snoozes,
 * listener status — can still nudge columns right after the first paint). */
async function leftOf(locator: Locator): Promise<number> {
  let previous = Number.NaN
  await expect
    .poll(async () => {
      const box = await locator.boundingBox()
      const current = box?.x ?? Number.NaN
      const settled = Math.abs(current - previous) < 0.01
      previous = current
      return settled
    })
    .toBe(true)
  return previous
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`Regras: pausar, ver esmaecida, reativar e abrir o menu ⋯ (${viewport.name}, ${theme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      const csrf = await apiLogin(page)
      const tag = Math.random().toString(36).slice(2, 8)
      const name = `Reativar ${tag}`
      await apiPost(page, '/rules', csrf, { name, include_terms: `reativar${tag}`, max_price_cents: 100_000 })

      await page.goto('/regras')
      const row = page.locator('tr', { has: page.getByText(name, { exact: true }) })
      await expect(row).toBeVisible()

      await page.waitForLoadState('networkidle')
      const activeToggle = row.getByRole('switch', { name: 'ativa' })
      await expect(activeToggle).toHaveAttribute('aria-checked', 'true')
      const activeX = await leftOf(activeToggle)
      const activeWidth = (await activeToggle.boundingBox())!.width
      const teto = row.locator('[data-label="Teto"]')
      const activeTetoX = await leftOf(teto)
      await expectNoHorizontalOverflow(page)
      await shoot(page, `${viewport.name}-${theme}-ativa`)

      // Pause: toast, dimmed row, same switch position and size.
      await activeToggle.click()
      await page.waitForLoadState('networkidle')
      const pausedToggle = row.getByRole('switch', { name: 'pausada' })
      await expect(pausedToggle).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('.toast')).toContainText('Regra pausada.')
      await expect(row).toHaveClass(/wide-table__row--paused/)
      expect(Number(await row.locator('td.crud-table__name').evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1)
      expect(await pausedToggle.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      expect(await leftOf(pausedToggle), 'o toggle não muda de posição').toBeCloseTo(activeX, 0)
      expect((await pausedToggle.boundingBox())!.width, 'nem de largura').toBeCloseTo(activeWidth, 0)
      expect(await leftOf(teto), 'nem os vizinhos').toBeCloseTo(activeTetoX, 0)
      await expectNoHorizontalOverflow(page)
      await shoot(page, `${viewport.name}-${theme}-pausada`)

      // Menu at the row's "⋯": every item present, danger ones last.
      const trigger = row.getByRole('button', { name: /^Mais ações da regra/ })
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const menu = page.getByRole('menu')
      await expect(menu.getByRole('menuitem')).toHaveText(['Duplicar', 'Silenciar', 'Limpar histórico', 'Excluir'])
      const menuBox = (await menu.boundingBox())!
      expect(menuBox.x).toBeGreaterThanOrEqual(0)
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width)
      await expectNoHorizontalOverflow(page)
      await shoot(page, `${viewport.name}-${theme}-menu`)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()

      // Resume.
      await pausedToggle.click()
      await expect(row.getByRole('switch', { name: 'ativa' })).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('.toast')).toContainText('Regra reativada.')
      await expect(row).not.toHaveClass(/wide-table__row--paused/)
      expect(await leftOf(row.getByRole('switch', { name: 'ativa' }))).toBeCloseTo(activeX, 0)

      // The state is real: it survives a reload.
      await page.reload()
      await expect(
        page.locator('tr', { has: page.getByText(name, { exact: true }) }).getByRole('switch', { name: 'ativa' }),
      ).toBeVisible()
    })
  }
}

test('Regras: o menu ⋯ da última linha não é cortado pelo contêiner da tabela', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  await apiPost(page, '/rules', csrf, { name: `Última ${tag}`, include_terms: `ultima${tag}` })
  await page.goto('/regras')

  const lastRow = page.locator('.wide-table-wrap').first().locator('tbody tr').last()
  await lastRow.getByRole('button', { name: /^Mais ações da regra/ }).click()
  const lastItem = page.getByRole('menuitem', { name: 'Excluir' })
  await expect(lastItem).toBeVisible()
  // Visible and actually on top of the page (not covered by the table card).
  const box = (await lastItem.boundingBox())!
  const topmost = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menuitem"]')?.textContent ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  expect(topmost).toBe('Excluir')

  // Outside click closes it.
  await page.mouse.click(5, 5)
  await expect(page.getByRole('menu')).toHaveCount(0)
})
