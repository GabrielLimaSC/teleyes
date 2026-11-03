import { test } from '@playwright/test'
const OUT = '/private/tmp/claude-501/-Users-lima-Work-Projects-teleyes-techlead/c7318a9a-a1a7-4861-af29-99851d5207f1/scratchpad'
for (const scheme of ['light', 'dark'] as const)
  for (const [w, h] of [[360, 780], [1440, 860]]) {
    test(`shot ${scheme} ${w}`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:5203', colorScheme: scheme, viewport: { width: w, height: h } })
      const page = await ctx.newPage()
      await page.goto('/')
      await page.fill('#password', 'e2e-test-password')
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/login-${scheme}-${w}.png`, fullPage: true })
      await ctx.close()
    })
  }
