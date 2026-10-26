import { describe, expect, it } from 'vitest'
import type { SavingsReport } from '../api/purchases'
import { savingsReport, TEST_PALETTE } from './fixtures'
import { buildResultsAggregates, buildResultsSvg, resultsJson } from './resultsCard'

const SECRETS = [
  'Grupo Secreto das Ofertas',
  'Canal Privado Hardware',
  'Texto da mensagem do Telegram com preço R$ 999',
  'https://t.me/c/123/456',
  'https://loja-secreta.example/produto',
  'segredo-product-key',
]

/** A report as a future API might return it, with every kind of Telegram content filled in. */
function pollutedReport(): SavingsReport {
  const base = savingsReport()
  const polluted = {
    ...base,
    source_name: SECRETS[0],
    groups: [SECRETS[1]],
    items: base.items.map((item) => ({
      ...item,
      source_name: SECRETS[0],
      message_text: SECRETS[2],
      message_link: SECRETS[3],
      url: SECRETS[4],
      product_key: SECRETS[5],
      savings: item.savings === null ? null : { ...item.savings, message_text: SECRETS[2] },
    })),
    noise: { ...base.noise, per_source: [{ source_name: SECRETS[1], count: 3 }], message_text: SECRETS[2] },
    black_friday: { ...base.black_friday, link: SECRETS[4] },
  }
  return polluted as SavingsReport
}

/** `toLocaleString` writes a no-break space after "R$"; compare with a plain one. */
const plain = (text: string) => text.replaceAll('\u00a0', ' ')

function everything(report: SavingsReport): string[] {
  const outputs: string[] = []
  for (const showPieces of [true, false]) {
    for (const includeStores of [true, false]) {
      const aggregates = buildResultsAggregates(report, { showPieces, includeStores })
      outputs.push(resultsJson(aggregates), buildResultsSvg(aggregates, TEST_PALETTE, null))
    }
  }
  return outputs
}

describe('results card privacy (S19-04)', () => {
  it('never carries a group name, message text, link or product key, in any option combination', () => {
    for (const output of everything(pollutedReport())) {
      for (const secret of SECRETS) expect(output).not.toContain(secret)
      // The only allowed URL-looking text is the SVG namespace declaration.
      expect(output.replace(/xmlns="[^"]*"/, '')).not.toMatch(/https?:\/\//)
      expect(output).not.toContain('t.me')
      expect(output).not.toContain('product_key')
    }
  })

  it('leaves the store names out unless "incluir lojas" is on', () => {
    const report = savingsReport()
    const off = buildResultsAggregates(report, { showPieces: true, includeStores: false })
    const on = buildResultsAggregates(report, { showPieces: true, includeStores: true })

    expect(resultsJson(off)).not.toContain('Loja Exemplo')
    expect(buildResultsSvg(off, TEST_PALETTE)).not.toContain('Loja Exemplo')
    expect(resultsJson(on)).toContain('Loja Exemplo')
    expect(buildResultsSvg(on, TEST_PALETTE)).toContain('Loja Exemplo')
  })

  it('leaves the piece names out when "mostrar peças" is off, even with stores on', () => {
    const aggregates = buildResultsAggregates(savingsReport(), { showPieces: false, includeStores: true })
    const outputs = [resultsJson(aggregates), buildResultsSvg(aggregates, TEST_PALETTE)]

    expect(aggregates.pieces).toBeUndefined()
    for (const output of outputs) {
      for (const name of ['Placa-mãe B850M', 'SSD NVMe 2 TB', 'Cabo HDMI', 'Loja Exemplo']) {
        expect(output).not.toContain(name)
      }
    }
  })

  it('exports only the whitelisted aggregate keys', () => {
    const aggregates = buildResultsAggregates(pollutedReport(), { showPieces: true, includeStores: false })

    expect(Object.keys(aggregates).sort()).toEqual(
      ['black_friday', 'generated_at', 'methodology', 'noise', 'pieces', 'schema', 'totals'].sort(),
    )
    expect(Object.keys(aggregates.pieces?.[0] ?? {}).sort()).toEqual(
      ['name', 'paid_cents', 'saving_vs_median_cents', 'saving_vs_median_pct'],
    )
  })
})

describe('results card content', () => {
  it('is a 1080x1350 image with the headline numbers', () => {
    const svg = plain(
      buildResultsSvg(
        buildResultsAggregates(savingsReport(), { showPieces: true, includeStores: false }),
        TEST_PALETTE,
      ),
    )

    expect(svg).toContain('width="1080"')
    expect(svg).toContain('height="1350"')
    expect(svg).toContain('ECONOMIA ESTIMADA')
    expect(svg).toContain('R$ 250,00')
    expect(svg).toContain('38–52 dias antes')
    expect(svg).toContain('20.298')
  })

  it('shows an overpayment honestly instead of hiding it', () => {
    const report = savingsReport({
      totals: {
        purchases: 1,
        linked_with_data: 1,
        total_paid_cents: 130_000,
        estimated_saving_cents: -30_000,
        reference_total_cents: 100_000,
        estimated_saving_pct: -30,
      },
    })

    const svg = plain(
      buildResultsSvg(buildResultsAggregates(report, { showPieces: false, includeStores: false }), TEST_PALETTE),
    )

    expect(svg).toContain('PAGO ACIMA DA MEDIANA')
    expect(svg).toContain('−R$ 300,00')
    expect(svg).not.toContain('ECONOMIA ESTIMADA')
  })

  it('says "sem dados" instead of inventing a saving when no purchase has history', () => {
    const report = savingsReport({
      totals: {
        purchases: 1,
        linked_with_data: 0,
        total_paid_cents: 5_000,
        estimated_saving_cents: 0,
        reference_total_cents: 0,
        estimated_saving_pct: null,
      },
    })

    const svg = buildResultsSvg(buildResultsAggregates(report, { showPieces: false, includeStores: false }), TEST_PALETTE)

    expect(svg).toContain('sem dados')
    expect(svg).not.toContain('R$ 0,00</text>')
  })

  it('escapes markup in a piece name', () => {
    const report = savingsReport()
    report.items[0] = { ...report.items[0]!, name: '<script>alert(1)</script> & "x"' }

    const svg = buildResultsSvg(buildResultsAggregates(report, { showPieces: true, includeStores: false }), TEST_PALETTE)

    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})
