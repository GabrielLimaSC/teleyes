import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost, apiPut, deleteMatchesFrom } from './helpers'

/**
 * S23-02: axe-core on every screen, light and dark, at 1440 and 390. Fails on
 * `serious`/`critical` WCAG 2.0/2.1/2.2 A+AA violations. Real backend; the data
 * is seeded per test (a product with two prices so the price chart renders).
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const TITLE = 'Placa de vídeo Palit RTX 5070 Ti GamingPro-S 16GB'
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]

async function scan(page: Page, label: string) {
  // Let the enter animations and the view transition settle first.
  await page.waitForTimeout(500)
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const report = bad
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n${v.nodes
          .slice(0, 4)
          .map((n) => `   ${n.target.join(' ')} :: ${n.failureSummary?.split('\n').slice(1, 3).join(' ') ?? ''}`)
          .join('\n')}`,
    )
    .join('\n')
  expect.soft(report === '' ? '' : `${label}\n${report}`).toBe('')
}

const tag = Math.random().toString(36).slice(2, 8)
const sourceName = `Loja A11y ${tag}`
let seeded = false

async function seed(page: Page) {
  await page.goto('/')
  const csrf = await apiLogin(page)
  if (seeded) return csrf
  seeded = true
  await apiPut(page, '/settings/feed', csrf, { group_duplicates: false })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrf, { name: `Regra A11y ${tag}`, include_terms: 'placa' })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest A11y ${tag}`,
    telegram_chat_id: `a11y-${tag}`,
    allowlisted: true,
    rules_mode: 'selected',
    rule_ids: [rule.id],
  })
  for (const [i, price] of ['5.999', '5.749'].entries()) {
    const source = await apiPost<{ id: number }>(page, '/sources', csrf, {
      name: i === 0 ? `${sourceName} B` : sourceName,
      telegram_chat_id: `a11y-src-${tag}-${i}`,
    })
    await apiPost(page, '/demo/messages', csrf, {
      source_id: source.id,
      rule_id: rule.id,
      recipient_ids: [recipient.id],
      text: `${TITLE} por R$ ${price}`,
    })
  }
  return csrf
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await deleteMatchesFrom(page, `Loja A11y ${tag}`)
  await page.close()
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const size of SIZES) {
    test.describe(`axe — ${colorScheme} ${size.name}`, () => {
      test.setTimeout(90_000)
      test.use({ colorScheme, viewport: { width: size.width, height: size.height } })

      test('login e telas simples', async ({ page }) => {
        await page.goto('/')
        await expect(page.getByLabel('Senha')).toBeVisible()
        await scan(page, 'Login')
        await seed(page)
        await page.goto('/')
        await expect(page.getByText(/Sessão ativa/)).toBeVisible()
        await scan(page, 'Início')
        for (const [route, heading] of [
          ['/historico', 'Histórico'],
          ['/economia', 'Economia'],
          ['/saude', 'Saúde'],
          ['/configuracao', 'Configuração'],
        ] as const) {
          await page.goto(route)
          await expect(page.getByRole('heading', { name: new RegExp(heading) }).first()).toBeVisible()
          await scan(page, heading)
        }
      })

      test('feed e painel de produto', async ({ page }) => {
        await seed(page)
        await page.goto('/feed')
        const card = page.locator('.match-card', { hasText: sourceName }).first()
        await expect(card).toBeVisible()
        await scan(page, 'Feed')
        await card.getByRole('button', { name: /Abrir produto/ }).click()
        await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
        await scan(page, 'Painel de produto')
      })

      test('regras, economia com formulário e diálogo de confirmação', async ({ page }) => {
        await seed(page)
        await page.goto('/regras')
        await page.locator('.rule-row__toggle', { hasText: `Regra A11y ${tag}` }).first().click()
        await scan(page, 'Regras (linha expandida)')
        await page.getByRole('button', { name: '+ Adicionar destinatário' }).click()
        await scan(page, 'Regras (trilho de destinatário)')

        await page.goto('/economia')
        await page.getByRole('button', { name: 'Registrar compra' }).click()
        await expect(page.getByRole('form', { name: 'Registrar compra' })).toBeVisible()
        await scan(page, 'Economia (registrar compra)')
      })

      test('fontes (duas abas)', async ({ page }) => {
        await seed(page)
        await page.goto('/fontes')
        await expect(page.getByRole('row', { name: new RegExp(sourceName) }).first()).toBeVisible()
        await scan(page, 'Fontes (aba manual)')
        const row = page.getByRole('row', { name: new RegExp(sourceName) }).first()
        await row.getByRole('button', { name: /Mais ações da fonte/ }).click()
        await scan(page, 'Fontes (menu ⋯)')
        await page.getByRole('menuitem', { name: 'Excluir' }).click()
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await scan(page, 'Diálogo de confirmação')
        await page.keyboard.press('Escape')
        await page.getByRole('tab', { name: 'Da minha conta' }).click()
        await scan(page, 'Fontes (da minha conta)')
      })
    })
  }
}
