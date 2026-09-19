import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apiLogin, apiPost } from './helpers'

function rowByExactName(page: Page, name: string) {
  return page
    .locator('tr')
    .filter({ has: page.locator('.crud-table__name', { hasText: new RegExp(`^${name}$`) }) })
}

test('creates, edits, duplicates and pauses a rule against the real API', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  // S11-05: the creation form is a permanent rail, and include terms are
  // chips — Enter or a comma closes one.
  await page.getByLabel(/Nome/).fill('RTX 5070 E2E')
  await page.getByLabel(/Termos incluídos/).fill('rtx 5070')
  await page.getByLabel(/Termos incluídos/).press('Enter')
  await page.getByLabel(/Termos incluídos/).fill('rtx 5070 super,')
  await page.getByLabel('Termos bloqueados').fill('usada')
  await page.getByLabel(/Preço máximo/).fill('5500')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  const createdRow = rowByExactName(page, 'RTX 5070 E2E')
  await expect(createdRow).toBeVisible()
  // Chips are only how it is edited: the API/table keep the comma string.
  await expect(createdRow.getByRole('cell', { name: 'rtx 5070, rtx 5070 super', exact: true })).toBeVisible()
  await expect(createdRow.getByRole('cell', { name: 'R$ 5.500,00' })).toBeVisible()
  await expect(createdRow.getByRole('button', { name: 'ativa' })).toBeVisible()

  // edit: the terms come back as chips; drop one and save
  await createdRow.getByRole('button', { name: 'Editar' }).click()
  await expect(page.getByRole('heading', { name: 'Editar regra' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remover termo rtx 5070 super' })).toBeVisible()
  await page.getByRole('button', { name: 'Remover termo rtx 5070 super' }).click()
  await page.getByLabel(/Nome/).fill('RTX 5070 Ti E2E')
  await page.getByRole('button', { name: 'Salvar alterações' }).click()
  const editedRow = rowByExactName(page, 'RTX 5070 Ti E2E')
  await expect(editedRow).toBeVisible()
  await expect(editedRow.getByRole('cell', { name: 'rtx 5070', exact: true })).toBeVisible()

  // duplicate
  await editedRow.getByRole('button', { name: 'Duplicar' }).click()
  await expect(page.getByRole('heading', { name: 'Nova regra' })).toBeVisible()
  await expect(page.getByLabel(/Nome/)).toHaveValue('RTX 5070 Ti E2E (cópia)')
  await page.getByRole('button', { name: 'Criar regra' }).click()
  await expect(rowByExactName(page, 'RTX 5070 Ti E2E \\(cópia\\)')).toBeVisible()

  // pause the original — one-directional per the API (no reactivate endpoint)
  await editedRow.getByRole('button', { name: 'ativa' }).click()
  await expect(editedRow.getByRole('button', { name: 'pausada' })).toBeVisible()
})

test('a term still typed when "Criar regra" is clicked is not lost (S11-05)', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  await page.getByLabel(/Nome/).fill('Termo Pendente E2E')
  await page.getByLabel(/Termos incluídos/).fill('termopendentee2e')
  await page.getByRole('button', { name: 'Criar regra' }).click()

  await expect(
    rowByExactName(page, 'Termo Pendente E2E').getByRole('cell', { name: 'termopendentee2e', exact: true }),
  ).toBeVisible()
})

test('the "Como uma regra casa" numbers are the real totals from the API (S11-05)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Painel',
    telegram_chat_id: '-100830',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'Regra E2E Painel',
    include_terms: 'painelitem',
    max_price_cents: 10_000,
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Painel',
    telegram_chat_id: '830',
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'painelitem barato por R$ 50',
  })

  // What the API itself says right now, read the same way the page does.
  const real = await page.evaluate(async () => {
    const matches = (await (await fetch('/matches', { credentials: 'same-origin' })).json()) as unknown[]
    const counters = (await (await fetch('/metrics', { credentials: 'same-origin' })).json()) as Array<{
      reason: string
      count: number
    }>
    const ceiling = counters
      .filter((counter) => counter.reason === 'preco_acima_teto')
      .reduce((sum, counter) => sum + counter.count, 0)
    return { matches: matches.length, ceiling }
  })
  expect(real.matches).toBeGreaterThanOrEqual(1)

  await page.goto('/regras')
  const panel = page.locator('.regras-how')
  await expect(panel.locator('.regras-how__stat', { hasText: 'Casaram' })).toContainText(String(real.matches))
  await expect(panel.locator('.regras-how__stat', { hasText: 'Descartadas por teto' })).toContainText(
    String(real.ceiling),
  )
  await expect(panel).toContainText('acumulados')
})

test('creating a source with a duplicate chat id shows the real 409 as feedback', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/fontes')

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome').fill('Grupo E2E Conflito')
  await page.getByLabel('Chat ID do Telegram').fill('-100555')
  await page.getByRole('button', { name: 'Salvar' }).click()
  await expect(rowByExactName(page, 'Grupo E2E Conflito')).toBeVisible()

  await page.getByRole('button', { name: '+ Nova fonte' }).click()
  await page.getByLabel('Nome').fill('Outro grupo')
  await page.getByLabel('Chat ID do Telegram').fill('-100555')
  await page.getByRole('button', { name: 'Salvar' }).click()

  await expect(page.getByRole('alert')).toBeVisible()
})

test('the Regras and Destinatários tables share the same container width and left edge (S7-01)', async ({
  page,
}) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  const wraps = page.locator('.crud-page .crud-table-wrap')
  await expect(wraps).toHaveCount(2)

  const rulesBox = await wraps.nth(0).boundingBox()
  const recipientsBox = await wraps.nth(1).boundingBox()
  expect(rulesBox).not.toBeNull()
  expect(recipientsBox).not.toBeNull()
  // Same left edge and width — the S7-01 bug was DestinatariosSection
  // rendering outside RegrasPage's 900px-centered `.crud-page` container,
  // stretching full-width instead of sharing it.
  expect(recipientsBox!.x).toBeCloseTo(rulesBox!.x, 0)
  expect(recipientsBox!.width).toBeCloseTo(rulesBox!.width, 0)
})

test('creates and pauses a recipient from the Regras page', async ({ page }) => {
  await page.goto('/')
  await apiLogin(page)
  await page.goto('/regras')

  // Scoped: the rule creation rail (S11-05) has its own "Nome" field.
  const recipients = page.locator('section.regras-section')
  await page.getByRole('button', { name: '+ Novo destinatário' }).click()
  await recipients.getByLabel('Nome').fill('Namorada E2E')
  await recipients.getByLabel('Chat ID do Telegram').fill('555444')
  await recipients.getByRole('button', { name: 'Salvar' }).click()

  const row = rowByExactName(page, 'Namorada E2E')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'ativa' }).click()
  await expect(row.getByRole('button', { name: 'pausada' })).toBeVisible()
})

test('clears a rule\'s match history against the real API, with a confirmation showing the real count (S10-04)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  const source = await apiPost<{ id: number }>(page, '/sources', csrfToken, {
    name: 'Grupo E2E Limpeza',
    telegram_chat_id: '-100556',
  })
  const rule = await apiPost<{ id: number }>(page, '/rules', csrfToken, {
    name: 'RTX 5070 Limpeza E2E',
    include_terms: 'gadgetlimpezae2e',
  })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrfToken, {
    name: 'Gabriel E2E Limpeza',
    telegram_chat_id: '985',
    allowlisted: true,
  })
  await apiPost(page, '/demo/messages', csrfToken, {
    source_id: source.id,
    rule_id: rule.id,
    recipient_ids: [recipient.id],
    text: 'gadgetlimpezae2e por R$ 199',
  })

  await page.goto('/feed')
  await expect(page.getByText('gadgetlimpezae2e por R$ 199')).toBeVisible()

  await page.goto('/regras')
  const row = rowByExactName(page, 'RTX 5070 Limpeza E2E')
  await row.getByRole('button', { name: 'Limpar histórico' }).click()

  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: RTX 5070 Limpeza E2E' }),
  ).toBeVisible()
  await expect(page.getByText('Isso apaga 1 match desta')).toBeVisible()

  await page.getByRole('button', { name: 'Apagar histórico' }).click()

  await expect(page.getByRole('status')).toHaveText('1 match apagado.×')
  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: RTX 5070 Limpeza E2E' }),
  ).not.toBeVisible()

  // Gone from the Feed for real, and the rule itself is still there, active.
  await page.goto('/feed')
  await expect(page.getByText('gadgetlimpezae2e por R$ 199')).not.toBeVisible()
  await page.goto('/regras')
  await expect(rowByExactName(page, 'RTX 5070 Limpeza E2E').getByRole('button', { name: 'ativa' })).toBeVisible()
})

test('clearing a rule with no matches shows a toast directly, no confirmation dialog (S10-04)', async ({
  page,
}) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)

  await apiPost(page, '/rules', csrfToken, {
    name: 'Regra Sem Match E2E',
    include_terms: 'termoquenuncabateu',
  })

  await page.goto('/regras')
  const row = rowByExactName(page, 'Regra Sem Match E2E')
  await row.getByRole('button', { name: 'Limpar histórico' }).click()

  await expect(page.getByRole('status')).toContainText('Nenhum match encontrado')
  await expect(
    page.getByRole('heading', { name: 'Limpar histórico: Regra Sem Match E2E' }),
  ).not.toBeVisible()
})

for (const width of [1280, 1440]) {
  test(`the Regras and Destinatários tables show every column and button, no clipping, at ${width}px (S11-05)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const csrfToken = await apiLogin(page)
    await apiPost(page, '/rules', csrfToken, {
      name: `Placa de vídeo RTX 5070 Ti ${width}`,
      include_terms: 'rtx 5070 ti, rtx 5070ti, placa de video rtx 5070 ti',
      exclude_terms: 'usada, defeito, caixa aberta',
      max_price_cents: 700_000,
    })
    await apiPost(page, '/recipients', csrfToken, {
      name: `Destinatário com nome bem comprido ${width}`,
      telegram_chat_id: `-100${width}77`,
      allowlisted: true,
    })
    await page.goto('/regras')

    const wraps = page.locator('.wide-table-wrap')
    await expect(wraps).toHaveCount(2)

    for (let index = 0; index < 2; index += 1) {
      const wrap = wraps.nth(index)
      const wrapBox = await wrap.boundingBox()
      expect(wrapBox).not.toBeNull()

      // Both the "Ações" header and every action button of every row sit
      // fully inside the card — `click()` scrolls on its own, so only the
      // boxes can catch a clipped column.
      const targets = [
        wrap.getByRole('columnheader', { name: 'Ações' }),
        ...(await wrap.getByRole('button', { name: /^(Editar|Duplicar|Testar|Limpar histórico|Excluir)$/ }).all()),
      ]
      for (const target of targets) {
        const box = await target.boundingBox()
        expect(box).not.toBeNull()
        const what = `"${(await target.textContent())?.trim()}" in table ${index + 1}`
        expect(box!.x, `${what}: left edge`).toBeGreaterThanOrEqual(wrapBox!.x - 0.5)
        expect(box!.x + box!.width, `${what}: right edge`).toBeLessThanOrEqual(wrapBox!.x + wrapBox!.width + 0.5)
      }

      const [scrollWidth, clientWidth] = await wrap.evaluate((el) => [el.scrollWidth, el.clientWidth])
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
    }

    const [pageScroll, pageClient] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ])
    expect(pageScroll).toBeLessThanOrEqual(pageClient + 1)
  })
}

test('the row loaded in the rail is highlighted while editing (S11-05)', async ({ page }) => {
  await page.goto('/')
  const csrfToken = await apiLogin(page)
  await apiPost(page, '/rules', csrfToken, { name: 'Regra Destaque E2E', include_terms: 'destaquee2e' })
  await page.goto('/regras')

  const row = rowByExactName(page, 'Regra Destaque E2E')
  await expect(row).not.toHaveClass(/wide-table__row--editing/)
  await row.getByRole('button', { name: 'Editar' }).click()
  await expect(row).toHaveClass(/wide-table__row--editing/)
  await page.getByRole('button', { name: 'Cancelar' }).click()
  await expect(row).not.toHaveClass(/wide-table__row--editing/)
})
