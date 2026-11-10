import { expect, test } from '@playwright/test'

/**
 * S27-05: on notebook widths the "Nova regra" rail plus the fixed columns used to
 * squeeze the rule name to ~100px (one letter per line). Runs on the seeded demo.
 */
for (const width of [1024, 1280, 1366, 1440]) {
  test(`Regras at ${width}px keeps the rule name readable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/')
    await page.getByLabel('Senha').fill('demo-teleyes')
    await page.getByRole('button', { name: 'Entrar' }).click()
    await expect(page.getByRole('heading', { name: 'Sessão ativa' })).toBeVisible()

    await page.goto('/regras')
    const name = page.locator('.rules-table__row .rules-table__name').first()
    await expect(name).toBeVisible()

    const box = await name.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(220)
    // A letter-per-line name makes the cell several times taller than two lines of text.
    expect(box?.height ?? 0).toBeLessThanOrEqual(110)
    // The page itself never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
