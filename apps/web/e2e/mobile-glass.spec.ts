import { expect, test } from '@playwright/test'
import { apiLogin } from './helpers'

// S25-M2: liquid glass chrome on the phone (390x844).
test.use({ viewport: { width: 390, height: 844 } })

test('the tab bar is a floating glass capsule and the pill follows the tab', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/')

  const bar = page.getByRole('navigation', { name: 'Navegação principal' })
  await expect(bar).toBeVisible()
  const style = await bar.evaluate((el) => {
    const css = getComputedStyle(el)
    return { blur: css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'), position: css.position }
  })
  expect(style.position).toBe('fixed')
  expect(style.blur).toContain('blur')

  const pill = bar.locator('.mobile-tabs__pill')
  const x0 = (await pill.boundingBox())!.x
  await bar.getByRole('link', { name: 'Regras' }).click()
  await expect(page).toHaveURL(/\/regras$/)
  // The pill springs to the third slot.
  await expect.poll(async () => (await pill.boundingBox())!.x, { timeout: 4000 }).toBeGreaterThan(x0 + 100)
})

test('the bar folds to icons when scrolling down and returns going up', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/historico')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: 'body { min-height: 3000px }' })

  const bar = page.getByRole('navigation', { name: 'Navegação principal' })
  await expect(bar).not.toHaveAttribute('data-compact', 'true')
  const full = (await bar.boundingBox())!.height

  for (let y = 0; y <= 600; y += 60) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.waitForTimeout(30)
  }
  await expect(bar).toHaveAttribute('data-compact', 'true')
  await expect.poll(async () => (await bar.boundingBox())!.height, { timeout: 4000 }).toBeLessThan(full - 8)

  for (let y = 600; y >= 400; y -= 40) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.waitForTimeout(30)
  }
  await expect(bar).not.toHaveAttribute('data-compact', 'true')
  await expect.poll(async () => (await bar.boundingBox())!.height, { timeout: 4000 }).toBeGreaterThanOrEqual(full - 1)
})
