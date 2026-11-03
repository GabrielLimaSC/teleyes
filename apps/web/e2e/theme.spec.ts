import { expect, test } from '@playwright/test'
import { apiLogin } from './helpers'

/**
 * S12-02: the theme mechanism, independent of the palette. Everything is read
 * from <html data-theme> / localStorage: the palette itself is checked elsewhere.
 */
const html = (page: import('@playwright/test').Page) => page.locator('html')

test.describe('system dark', () => {
  test.use({ colorScheme: 'dark' })

  test('data-theme="dark" is set before the first paint (no flash)', async ({ page }) => {
    // Hold the app bundle: while it is blocked nothing of the app can have run
    // or rendered, so whatever is on <html> came from the inline <head> script.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(/\/src\/main\.tsx/, async (route) => {
      await held
      await route.continue()
    })

    await page.goto('/', { waitUntil: 'commit' })
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveAttribute('data-theme-preference', 'system')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0f1116')
    expect(await page.locator('#root').innerHTML(), 'the app has not rendered yet').toBe('')

    release()
    await expect(page.getByLabel('Senha')).toBeVisible()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
  })
})

test.describe('system light', () => {
  test.use({ colorScheme: 'light' })

  test('starts light, with the light browser chrome color', async ({ page }) => {
    await page.goto('/')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f5f5f5')
  })

  test('the toggle cycles Sistema → Claro → Escuro and the choice survives a reload', async ({ page }) => {
    await page.goto('/')
    const toggle = page.getByRole('button', { name: /^Tema: / })
    await expect(toggle).toHaveAccessibleName('Tema: Sistema')

    await toggle.click()
    await expect(toggle).toHaveAccessibleName('Tema: Claro')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')

    await toggle.click()
    await expect(toggle).toHaveAccessibleName('Tema: Escuro')
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0f1116')

    // An explicit choice beats the (light) OS, and outlives the page.
    await page.reload()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    await expect(html(page)).toHaveAttribute('data-theme-preference', 'dark')
    await expect(page.getByRole('button', { name: 'Tema: Escuro' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('teleyes.theme'))).toBe('dark')

    await page.getByRole('button', { name: 'Tema: Escuro' }).click()
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Tema: Sistema' })).toBeVisible()
  })

  test('with "Sistema" selected, changing the OS theme updates the page live', async ({ page }) => {
    await page.goto('/')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html(page)).toHaveAttribute('data-theme', 'light')

    // An explicit choice ignores the OS.
    await page.getByRole('button', { name: 'Tema: Sistema' }).click() // → Claro
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
  })

  test('blocked storage does not break the page or the toggle', async ({ page }) => {
    // What a browser with storage blocked does: touching localStorage throws.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto('/')
    await expect(html(page)).toHaveAttribute('data-theme', 'light')
    await expect(page.getByLabel('Senha')).toBeVisible()

    const toggle = page.getByRole('button', { name: /^Tema: / })
    await toggle.click()
    await toggle.click()
    await expect(html(page)).toHaveAttribute('data-theme', 'dark')
    expect(errors).toEqual([])
  })
})

test('the toggle is the 8th slot inside the navbar capsule (S21-01)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [800, 700],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto('/regras')
    await expect(page.getByRole('heading', { name: 'Regras' }).first()).toBeVisible()

    const button = (await page.getByRole('button', { name: /^Tema: / }).boundingBox())!
    const capsule = (await page.locator('.nav-capsule').boundingBox())!
    const mascot = (await page.locator('.nav-mascot').boundingBox())!

    expect(button.x, `${width}px: inside, left`).toBeGreaterThanOrEqual(capsule.x)
    expect(button.x + button.width, `${width}px: inside, right`).toBeLessThanOrEqual(capsule.x + capsule.width)
    expect(button.x, `${width}px: right of the mascot`).toBeGreaterThanOrEqual(mascot.x + mascot.width)
    // Same row as the other tabs.
    const saude = (await page.getByRole('link', { name: 'Saúde' }).boundingBox())!
    expect(Math.abs(button.y - saude.y)).toBeLessThan(1)
    expect(button.x, `${width}px: after Saúde`).toBeGreaterThanOrEqual(saude.x + saude.width)
  }
})

test('the toggle is reachable by keyboard and its tooltip says the state in words', async ({ page }) => {
  await page.goto('/')
  const toggle = page.getByRole('button', { name: /^Tema: / })
  await toggle.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await expect(page.getByRole('tooltip')).toContainText(/Tema: (Sistema|Claro|Escuro) · clique para/)
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAccessibleName(/Tema: (Claro|Escuro)/)
})
