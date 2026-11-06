import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin } from './helpers'

// S25-M1: motion base. Short flows that open/close things while they animate;
// what matters is that nothing throws and focus ends up where it belongs.

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a sheet and a dialog open and close with their exit animation, focus back on the opener', async ({ page }) => {
    const errors = trackErrors(page)
    await page.goto('/')
    await apiLogin(page)
    await page.goto('/feed')

    const more = page.getByRole('button', { name: 'Mais', exact: true })
    await more.click()
    const sheet = page.getByRole('dialog', { name: 'Mais' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Fechar' })).toBeFocused()

    await sheet.getByRole('button', { name: 'Fechar' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(more).toBeFocused()

    // Quick reopen/close: the exit must not leave a ghost behind.
    await more.click()
    await expect(page.getByRole('dialog', { name: 'Mais' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Mais' })).toHaveCount(0)

    await more.click()
    await page.getByRole('dialog', { name: 'Mais' }).getByRole('button', { name: 'Sair', exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toHaveCount(0)
    // The animated copy of the dialog removes itself as well.
    await expect(page.locator('.confirm-dialog__backdrop')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('switching the Regras tabs slides the content and glides the indicator', async ({ page }) => {
    const errors = trackErrors(page)
    await page.goto('/')
    await apiLogin(page)
    await page.goto('/regras')

    const tabs = page.getByRole('tablist', { name: 'Seções de Regras' })
    await expect(tabs.getByRole('tab', { name: 'Regras' })).toHaveAttribute('aria-selected', 'true')
    const thumb = tabs.locator('.motion-seg__thumb')
    await expect(thumb).toHaveCSS('opacity', '1')
    const before = (await thumb.boundingBox())!

    await tabs.getByRole('tab', { name: 'Entrega' }).click()
    await expect(tabs.getByRole('tab', { name: 'Entrega' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.motion-swap')).toHaveAttribute('data-swap-direction', 'forward')
    // Once the spring settles the indicator is under the new tab.
    await expect
      .poll(async () => (await thumb.boundingBox())!.x, { timeout: 3000 })
      .toBeGreaterThan(before.x + 100)
    await expect(page.locator('.motion-swap__ghost')).toHaveCount(0)

    await tabs.getByRole('tab', { name: 'Destinatários' }).click()
    await expect(page.locator('.motion-swap')).toHaveAttribute('data-swap-direction', 'back')
    await expect(tabs.getByRole('tab', { name: 'Destinatários' })).toHaveAttribute('aria-selected', 'true')
    expect(errors).toEqual([])
  })
})

test('the page changes through a view transition without eating fast clicks', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/feed')

  const nav = page.getByRole('navigation', { name: 'Navegação principal' })
  await nav.getByRole('link', { name: 'Regras' }).click()
  await nav.getByRole('link', { name: 'Histórico' }).click()
  await expect(page).toHaveURL(/\/historico$/)
  await expect(page.getByRole('heading', { name: 'Histórico' }).first()).toBeVisible()
  // The transition is over: no leftover pseudo-element layer on the page.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 3000 }).toBeLessThan(40)
  expect(errors).toEqual([])
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } })

  test('the sheet still opens and closes', async ({ page }) => {
    const errors = trackErrors(page)
    await page.goto('/')
    await apiLogin(page)
    await page.goto('/feed')
    await page.getByRole('button', { name: 'Mais', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Mais' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Mais' })).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
