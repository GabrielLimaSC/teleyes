import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { apiLogin, apiPost, clickRuleFilter } from './helpers'

/**
 * S16-02: conteúdo dos trilhos do Feed no novo design — real backend, tag
 * aleatória. O backend é compartilhado (outros specs rodando em paralelo, e
 * as próprias repetições de `--repeat-each` acumulam na mesma sessão), então
 * nada aqui assume contagens globais fixas: "Ver todas"/"Alvos de preço" leem
 * o total real via `GET /rules` antes de comparar, e os tiles do "Resumo"
 * são sempre lidos com um filtro de regra aplicado (escopados a um número
 * conhecido, nunca ao feed inteiro).
 *
 * Nome começa com "scroll-" de propósito (ordem alfabética): este spec
 * semeia matches, e `feed.spec.ts` exige o backend ainda vazio no seu
 * primeiro teste — rodar depois dele evita o choque (mesmo motivo do
 * "match-" em match-card-layout.spec.ts).
 *
 *  - "Filtrar por regra": "Ver todas" mostra/esconde o resto; a regra
 *    selecionada nunca fica escondida atrás do fold.
 *  - Trilho recolhido (ícones): badge numérico só quando > 0, tooltip de
 *    vidro no hover E no foco do teclado, sempre inteiro na tela.
 *  - "Resumo": os tiles batem com os dados reais semeados — Matches,
 *    Enviados (sempre 0 no backend de e2e, sem token de bot) e "Menor
 *    preço" ignorando um outlier de parsing abaixo de 20% da mediana da
 *    própria regra.
 */

interface Seeded {
  /** 8 rules, busiest first — `ruleNames[0]` has 8 matches (and the only
   * price target this seed adds), `ruleNames[7]` has 1. */
  ruleNames: string[]
  leastBusyRuleName: string
  targetedRuleName: string
}

async function seedManyRules(page: Page): Promise<Seeded> {
  await page.goto('/')
  const csrf = await apiLogin(page)
  const tag = Math.random().toString(36).slice(2, 8)
  const source = await apiPost<{ id: number }>(page, '/sources', csrf, { name: `Fonte ${tag}`, telegram_chat_id: `c-${tag}` })
  const recipient = await apiPost<{ id: number }>(page, '/recipients', csrf, {
    name: `Dest ${tag}`,
    telegram_chat_id: `d-${tag}`,
    allowlisted: true,
  })

  const counts = [8, 7, 6, 5, 4, 3, 2, 1]
  const ruleNames: string[] = []
  for (const [index, count] of counts.entries()) {
    const name = `Regra ${tag}-${index}`
    ruleNames.push(name)
    const rule = await apiPost<{ id: number }>(page, '/rules', csrf, {
      name,
      include_terms: `termo${tag}${index}`,
      // One rule (the busiest) carries a price target — asserted against
      // the real total from `GET /rules`, below, never a hardcoded count.
      target_price_cents: index === 0 ? 100_00 : null,
    })
    for (let i = 0; i < count; i += 1) {
      await apiPost(page, '/demo/messages', csrf, {
        source_id: source.id,
        rule_id: rule.id,
        recipient_ids: [recipient.id],
        text: `Produto ${tag}-${index}-${i} termo${tag}${index} por R$ ${200 + i * 17},00`,
      })
    }
  }

  return { ruleNames, leastBusyRuleName: ruleNames[ruleNames.length - 1], targetedRuleName: ruleNames[0] }
}

/** The real, current totals `GET /rules` holds — the only correct baseline
 * on a backend other tests (or earlier repeats of this very spec) have
 * already added rules to. */
async function fetchRuleTotals(page: Page): Promise<{ total: number; withTarget: number }> {
  return page.evaluate(async () => {
    const response = await fetch('/rules', { credentials: 'same-origin' })
    const rules = (await response.json()) as { target_price_cents: number | null }[]
    return { total: rules.length, withTarget: rules.filter((rule) => rule.target_price_cents !== null).length }
  })
}

async function viewportBox(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('bounding box missing')
  return box
}

function countWord(n: number): string {
  return n === 1 ? 'ativo' : 'ativos'
}

test('"Filtrar por regra": "Ver todas" mostra/esconde o resto, e a regra selecionada nunca some', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const seed = await seedManyRules(page)
  await page.goto('/feed')
  await expect(page.locator('.feed-rail__rule').first()).toBeVisible()

  const { total } = await fetchRuleTotals(page)
  const fullCount = total + 1 // + "Todas as regras", which is never part of the fold

  // Recolhida (default): menos que o total — pelo menos as 8 regras recém
  // -criadas garantem algo escondido atrás do fold de 6.
  const collapsedCount = await page.locator('.feed-rail__rule').count()
  expect(collapsedCount).toBeLessThan(fullCount)

  const moreButton = page.getByRole('button', { name: /^Ver todas ·/ })
  await expect(moreButton).toBeVisible()
  await moreButton.click()

  // Expandida: todas aparecem.
  await expect(page.locator('.feed-rail__rule')).toHaveCount(fullCount)
  const lessButton = page.getByRole('button', { name: 'Ver menos' })
  await expect(lessButton).toBeVisible()

  // Seleciona a regra menos movimentada deste seed (quase certamente fora
  // do top 6 global) enquanto a lista ainda está toda visível.
  await clickRuleFilter(page, new RegExp(`^${seed.leastBusyRuleName}`))
  await lessButton.click()

  // Recolhida de novo — mas a regra selecionada continua visível, nunca
  // escondida atrás do fold que ela mesma provocaria (seja ela a 7ª regra
  // injetada além do top 6, ou já uma das 6 — o único invariante que
  // importa aqui é "nunca escondida").
  const finalCount = await page.locator('.feed-rail__rule').count()
  expect(finalCount).toBeGreaterThanOrEqual(collapsedCount)
  expect(finalCount).toBeLessThanOrEqual(collapsedCount + 1)
  await expect(page.getByRole('button', { name: new RegExp(`^${seed.leastBusyRuleName}`) })).toBeVisible()
  await expect(page.locator('.feed-rail__rule--active', { hasText: seed.leastBusyRuleName })).toBeVisible()
})

test('trilho recolhido: badge só com número > 0, tooltip no hover e no foco, sempre inteiro na tela', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const seed = await seedManyRules(page)
  await page.goto('/feed')
  await expect(page.locator('.feed-rail__rule').first()).toBeVisible()

  const { withTarget } = await fetchRuleTotals(page)

  // Filtra pela regra com alvo deste seed (8 matches, preços reais
  // R$200–R$319, sem outlier) — escopa "Resumo" a um número conhecido: sem
  // filtro, "Matches" contaria também os matches de outras regras no
  // backend compartilhado.
  await clickRuleFilter(page, new RegExp(`^${seed.targetedRuleName}`))

  // Os tiles do "Resumo" expandido batem com o que foi semeado: 8 matches,
  // 0 enviados (backend de e2e roda sem token de bot — toda entrega fica
  // "not_configured", nunca "sent", packages/notifications/bot.py) e o
  // menor preço real (R$ 200,00) — nunca um outlier, já que nenhum preço
  // aqui fica abaixo de 20% da mediana da própria regra.
  const resumo = page.locator('.feed-summary')
  const matchesTile = resumo.locator('.feed-summary__tile', { hasText: 'Matches' })
  await expect(matchesTile).toContainText('8')
  const sentTile = resumo.locator('.feed-summary__tile', { hasText: 'Enviados' })
  await expect(sentTile).toContainText('0')
  const priceTile = resumo.locator('.feed-summary__tile', { hasText: 'Menor preço' })
  await expect(priceTile).toContainText('R$ 200,00')

  // Volta para "Todas as regras": o filtro deixava a lista de matches curta
  // demais (só 8 cards) para rolar os trilhos pra fora da tela a seguir —
  // sem filtro ela volta a ter altura de sobra (como nos outros specs de
  // scroll-chrome/scroll-rail-pinned).
  await page.getByRole('button', { name: 'Todas as regras' }).click()

  // Rola até o fim da página — os dois trilhos saem da tela e viram a tira
  // de ícones (scrollTo o fim, não um valor calculado: robusto mesmo com o
  // backend compartilhado deixando os trilhos mais altos a cada rodada).
  await page.mouse.move(720, 500)
  await page.mouse.wheel(0, 200)
  await expect(page.locator('html')).toHaveAttribute('data-chrome', 'compact')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-left-rail', 'collapsed')
  await expect(page.locator('.feed-page__grid')).toHaveAttribute('data-right-rail', 'collapsed')
  await page.waitForTimeout(900)

  // "Alvos de preço": badge com o total real de regras com alvo (nunca
  // hardcoded — outras rodadas/specs podem ter deixado mais de uma).
  const targetButton = page.getByRole('button', { name: new RegExp(`^Alvos de preço · ${withTarget}$`) })
  await expect(targetButton).toBeVisible()
  await expect(targetButton.locator('.rail-strip__badge')).toHaveText(String(withTarget))

  // "Enviados" (ícone avião): backend de e2e nunca envia (not_configured) —
  // SEM badge, nome acessível sem sufixo — o "só quando > 0" do design.
  const sentButton = page.getByRole('button', { name: 'Enviados', exact: true })
  await expect(sentButton).toBeVisible()
  await expect(sentButton.locator('.rail-strip__badge')).toHaveCount(0)

  // "Matches" (ícone gráfico): sem filtro agora, mas sempre > 0 (acabamos de
  // semear 36 matches) — confirma o "badge só com número > 0" do outro lado.
  const matchesButton = page.getByRole('button', { name: /^Resumo · \d+$/ })
  await expect(matchesButton).toBeVisible()
  await expect(matchesButton.locator('.rail-strip__badge')).toBeVisible()

  // Tooltip: aparece no hover, mostra rótulo + contexto, e fica inteiro na
  // tela (nunca cortado pelo próprio `overflow: hidden` do trilho recolhido
  // — é um portal com `position: fixed`, RailStrip.tsx).
  const viewport = page.viewportSize()!
  await targetButton.hover()
  const tooltip = page.getByRole('tooltip', { name: /^Alvos de preço ·/ })
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(`${withTarget} ${countWord(withTarget)}`)
  const tooltipBox = await viewportBox(tooltip)
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0)
  expect(tooltipBox.y).toBeGreaterThanOrEqual(0)
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(viewport.width)
  expect(tooltipBox.y + tooltipBox.height).toBeLessThanOrEqual(viewport.height)

  // Sai do hover: some.
  await page.mouse.move(viewport.width / 2, viewport.height - 20)
  await expect(tooltip).toBeHidden()

  // Foco do teclado (não só mouse): o mesmo tooltip aparece.
  await targetButton.focus()
  await expect(tooltip).toBeVisible()
  await targetButton.evaluate((element) => (element as HTMLElement).blur())
  await expect(tooltip).toBeHidden()
})
