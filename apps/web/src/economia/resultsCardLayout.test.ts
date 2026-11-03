import { describe, expect, it } from 'vitest'
import type { SavingsReport } from '../api/purchases'
import { reportItem, savingsNoData, savingsOk, savingsReport, TEST_PALETTE } from './fixtures'
import { buildResultsAggregates, buildResultsSvg, estimateTextWidth } from './resultsCard'

const plain = (text: string) => text.replaceAll(' ', ' ')

interface TextBox {
  content: string
  left: number
  right: number
  top: number
  bottom: number
}

/** Rough box of every <text> in the card, using the same width estimate the layout uses. */
function textBoxes(svg: string): TextBox[] {
  const boxes: TextBox[] = []
  for (const match of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = match[1] ?? ''
    const content = (match[2] ?? '').replaceAll(/&[a-z]+;/g, 'x')
    const num = (name: string) => Number(new RegExp(`(?:^| )${name}="([^"]*)"`).exec(attrs)?.[1])
    const x = num('x')
    const y = num('y')
    const size = num('font-size')
    const bold = /font-weight="[678]00"/.test(attrs)
    const width = estimateTextWidth(content, size, bold)
    const end = attrs.includes('text-anchor="end"')
    boxes.push({
      content,
      left: end ? x - width : x,
      right: end ? x : x + width,
      top: y - size * 0.8,
      bottom: y + size * 0.2,
    })
  }
  return boxes
}

function expectNoOverlap(svg: string) {
  const boxes = textBoxes(svg)
  expect(boxes.length).toBeGreaterThan(5)
  for (const box of boxes) {
    expect(box.left, box.content).toBeGreaterThanOrEqual(0)
    expect(box.right, box.content).toBeLessThanOrEqual(1080)
    expect(box.bottom, box.content).toBeLessThanOrEqual(1350)
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!
      const b = boxes[j]!
      const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      expect(overlaps, `"${a.content}" overlaps "${b.content}"`).toBe(false)
    }
  }
}

function longReport(): SavingsReport {
  const base = savingsReport()
  const items = [1, 2, 3, 4, 5, 6].map((id) =>
    reportItem({
      id,
      name: `Peça com um nome bastante comprido número ${id} para forçar truncamento`,
      price_cents: 12_345_678,
      savings:
        id === 3 ? savingsNoData() : savingsOk({ saving_vs_median_cents: 12_345_678, saving_vs_median_pct: 12.3 }),
    }),
  )
  return {
    ...base,
    items,
    totals: {
      purchases: 6,
      linked_with_data: 5,
      total_paid_cents: 74_074_068,
      estimated_saving_cents: 12_345_678,
      reference_total_cents: 100_000_000,
      estimated_saving_pct: 12.3,
    },
  }
}

describe('results card layout (S21-04)', () => {
  const options = { showPieces: true, includeStores: true }

  it('does not overlap with long values (R$ 123.456,78) in the positive state', () => {
    const svg = buildResultsSvg(buildResultsAggregates(longReport(), options), TEST_PALETTE)
    expect(plain(svg)).toContain('+R$ 123.456,78')
    expectNoOverlap(svg)
  })

  it('does not overlap in the negative state, with the overpayment in the bad colour', () => {
    const report = longReport()
    report.totals = { ...report.totals, estimated_saving_cents: -12_345_678, estimated_saving_pct: -12.3 }
    report.items = report.items.map((item) =>
      item.savings?.status === 'ok'
        ? { ...item, savings: { ...item.savings, saving_vs_median_cents: -12_345_678, saving_vs_median_pct: -12.3 } }
        : item,
    )
    const svg = buildResultsSvg(buildResultsAggregates(report, options), TEST_PALETTE)
    expect(plain(svg)).toContain('−R$ 123.456,78')
    expect(svg).toMatch(/fill="var\(--bad\)"[^>]*>−R\$/)
    expectNoOverlap(svg)
  })

  it('lists purchases without history as "sem histórico" and stays clean when nothing has data', () => {
    const report = longReport()
    report.totals = { ...report.totals, linked_with_data: 0, estimated_saving_cents: 0, estimated_saving_pct: null }
    report.items = report.items.map((item) => ({ ...item, savings: savingsNoData() }))
    const svg = buildResultsSvg(buildResultsAggregates(report, options), TEST_PALETTE)
    expect(svg).toContain('sem dados')
    expect(svg).toContain('sem histórico')
    expectNoOverlap(svg)
  })

  it('does not overlap with a normal report or with no pieces at all', () => {
    for (const showPieces of [true, false]) {
      expectNoOverlap(
        buildResultsSvg(buildResultsAggregates(savingsReport(), { showPieces, includeStores: false }), TEST_PALETTE),
      )
    }
  })
})
