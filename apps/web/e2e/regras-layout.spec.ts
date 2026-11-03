import { expect, test } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

/**
 * S15-02: tela de Regras compacta. Regressões cobertas:
 * - as 7 ações da linha empilhavam em até 4 fileiras (linha ~170px);
 * - "Histórico 30d" em branco: `--plane-chart-line` não existia em nenhum
 *   tema (sem stroke) e uma série de 1 dia virava polyline de 1 ponto;
 * - "Testar" do formulário e "Salvar entrega" sem tamanho próprio (achatados).
 *
 * Real backend (`/demo/messages`); tag aleatória, backend compartilhado.
 */
test('Regras: ações numa fileira só (S18-01), histórico visível e botões com altura real', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Fonte ${tag}`, telegram_chat_id: `c-${tag}` })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest ${tag}`,
    telegram_chat_id: `d-${tag}`,
    allowlisted: true,
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrf, {
    name: `Layout ${tag}`,
    include_terms: `layout${tag}, AMD Ryzen 7 9800X3D, AMDRyzen79800X3D, AMD Ryzen7 9800X3D`,
    target_price_cents: 220_000,
  })
  await apiPost(page, '/demo/messages', csrf, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: `Processador layout${tag} por R$ 2.249,00`,
  })

  await page.goto('/regras')
  const row = page.locator('tr', { has: page.getByText(`Layout ${tag}`, { exact: true }) })
  await expect(row).toBeVisible()

  // S21-02: the closed row has no actions beyond the toggle and the "⋯" menu,
  // and no sparkline column; the chart lives in the opened row.
  await expect(row.getByRole('button', { name: /^Mais ações da regra/ })).toBeVisible()
  await expect(row.locator('.rule-sparkline')).toHaveCount(0)
  await row.getByRole('button', { name: /^Layout/ }).click()
  const line = page.locator('.rule-detail .rule-chart__line')
  await expect(line).toHaveCount(1)
  expect(await line.evaluate((el) => getComputedStyle(el).stroke)).not.toBe('none')
  expect(((await line.getAttribute('points')) ?? '').split(' ').length).toBeGreaterThanOrEqual(2)

  await page.getByRole('button', { name: 'Ajustes de entrega' }).click()
  for (const name of ['Testar', 'Salvar entrega']) {
    const button = page.locator('.regras-form, .anchored-popover__panel').getByRole('button', { name, exact: true })
    const box = await button.boundingBox()
    expect(box!.height, `"${name}" com altura de botão`).toBeGreaterThanOrEqual(28)
  }
})
