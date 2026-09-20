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

test('the toggle is a fixed glass button that never sits on the navbar capsule', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [800, 700],
    [390, 844],
    [320, 700],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto('/feed')
    await expect(page.getByRole('heading', { name: 'Feed ao vivo' })).toBeVisible()

    const toggle = page.getByRole('button', { name: /^Tema: / })
    const button = (await toggle.boundingBox())!
    const capsule = (await page.locator('.nav-capsule').boundingBox())!

    // Fixed to the top-right corner of the viewport, fully on screen.
    expect(button.y, `${width}px: top`).toBeLessThan(60)
    expect(button.x + button.width, `${width}px: right edge`).toBeLessThanOrEqual(width)
    expect(button.x + button.width, `${width}px: near the right`).toBeGreaterThan(width - 60)
    // No overlap with the capsule.
    expect(button.x, `${width}px: clear of the capsule`).toBeGreaterThanOrEqual(capsule.x + capsule.width)

    // Fixed: still there after scrolling.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const after = (await toggle.boundingBox())!
    expect(after.y).toBeCloseTo(button.y, 0)
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
