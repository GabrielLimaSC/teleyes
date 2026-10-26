import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { apiLogin } from './helpers'

const STORE = 'Loja E2E Secreta'

async function noHorizontalScroll(page: import('@playwright/test').Page) {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ])
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
}

test('registers a purchase, sees the report and exports the results card (S19-04)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/economia')

  await expect(page.getByRole('heading', { name: 'Economia' })).toBeVisible()
  await expect(page.getByText(/Estimativa baseada só nos preços que o próprio teleyes viu/)).toBeVisible()

  await page.getByRole('button', { name: 'Registrar compra' }).click()
  const form = page.getByRole('form', { name: 'Registrar compra' })
  await form.getByLabel('Peça ou categoria').fill('Placa-mãe E2E B850M')
  await form.getByLabel('Preço pago (R$)').fill('1.199,90')
  await form.getByLabel('Loja (opcional)').fill(STORE)
  await form.getByRole('button', { name: 'Salvar compra' }).click()

  const row = page.getByRole('row', { name: /Placa-mãe E2E B850M/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('1.199,90')
  // No link to a product: only the amount paid is reported, never an invented saving.
  await expect(row.locator('[data-label="Economia estimada"]')).toHaveText('—')
  await expect(page.getByRole('region', { name: 'Resumo' })).toContainText('sem dados')

  // Editing goes through the same form.
  await row.getByRole('button', { name: 'Editar' }).click()
  const editForm = page.getByRole('form', { name: 'Editar compra' })
  await editForm.getByLabel('Preço pago (R$)').fill('1100')
  await editForm.getByRole('button', { name: 'Salvar compra' }).click()
  await expect(page.getByRole('row', { name: /Placa-mãe E2E B850M/ })).toContainText('1.100,00')

  // The results card: stores are off by default.
  await page.getByRole('button', { name: 'Gerar cartão de resultados' }).click()
  await expect(page.getByRole('checkbox', { name: 'Incluir lojas' })).not.toBeChecked()
  await expect(page.getByRole('img', { name: 'Prévia do cartão de resultados' })).toBeVisible()

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar JSON' }).click(),
  ])
  const jsonText = readFileSync(await jsonDownload.path(), 'utf8')
  expect(jsonDownload.suggestedFilename()).toBe('teleyes-economia.json')
  expect(jsonText).toContain('Placa-mãe E2E B850M')
  expect(jsonText).not.toContain(STORE)
  expect(jsonText).not.toMatch(/https?:\/\//)

  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar imagem (PNG)' }).click(),
  ])
  expect(pngDownload.suggestedFilename()).toBe('teleyes-economia.png')
  const png = readFileSync(await pngDownload.path())
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  // 1080 x 1350 in the IHDR chunk.
  expect(png.readUInt32BE(16)).toBe(1080)
  expect(png.readUInt32BE(20)).toBe(1350)

  // Hiding the pieces removes their names from the export.
  await page.getByRole('checkbox', { name: 'Mostrar peças' }).uncheck()
  const [hiddenDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Baixar JSON' }).click(),
  ])
  expect(readFileSync(await hiddenDownload.path(), 'utf8')).not.toContain('Placa-mãe E2E B850M')

  // Deleting needs a confirmation.
  await page.getByRole('row', { name: /Placa-mãe E2E B850M/ }).getByRole('button', { name: 'Excluir' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Excluir compra' }).click()
  await expect(page.getByRole('row', { name: /Placa-mãe E2E B850M/ })).toHaveCount(0)
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`economia fits a 390px screen without a horizontal scrollbar in the ${colorScheme} theme`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme, viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto('/')
    const csrfToken = await apiLogin(page)
    await page.evaluate(
      async (token) => {
        await fetch('/purchases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
          credentials: 'same-origin',
          body: JSON.stringify({
            name: 'SSD NVMe 2 TB com um nome bem longo para testar a quebra de linha no celular',
            price_cents: 48_990,
            purchased_at: new Date().toISOString(),
            store: 'Loja',
            product_key: null,
            rule_id: null,
          }),
        })
      },
      csrfToken,
    )
    await page.goto('/economia')
    await expect(page.getByRole('row', { name: /SSD NVMe 2 TB/ }).first()).toBeVisible()
    await noHorizontalScroll(page)

    await page.getByRole('button', { name: 'Registrar compra' }).click()
    await expect(page.getByRole('form', { name: 'Registrar compra' })).toBeVisible()
    await noHorizontalScroll(page)

    await page.getByRole('button', { name: 'Cancelar' }).click()
    await page.getByRole('button', { name: 'Gerar cartão de resultados' }).click()
    await expect(page.getByRole('img', { name: 'Prévia do cartão de resultados' })).toBeVisible()
    await noHorizontalScroll(page)

    await page.screenshot({ path: `test-results/economia/mobile-${colorScheme}.png`, fullPage: true })
    await context.close()
  })
}
