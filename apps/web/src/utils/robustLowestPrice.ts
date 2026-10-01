/**
 * S16-02: "Menor preço" (the Resumo rail's tile) ignores a price that is
 * almost certainly a parsing error — below 20% of the median price of its
 * own rule — before taking the minimum across all of them. Without this a
 * single botched "R$ 1,00" wins over every real price just because it's the
 * smallest number on the feed. Pure (no `Match`/`Rule` import) so it never
 * needs the full fixtures to unit-test, and so the Resumo tile can trust the
 * same answer this function gives a vitest case.
 */

export interface RobustPriceInput {
  ruleId: number
  priceCents: number
}

function medianOf(prices: number[]): number {
  const sorted = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** `null` with no priced match at all, or when every price was filtered out
 * as an outlier (never happens with real data — a rule's own median is
 * always one of its real prices, so it always clears its own 20% floor). */
export function robustLowestPriceCents(prices: RobustPriceInput[]): number | null {
  if (prices.length === 0) return null

  const byRule = new Map<number, number[]>()
  for (const { ruleId, priceCents } of prices) {
    const list = byRule.get(ruleId)
    if (list) list.push(priceCents)
    else byRule.set(ruleId, [priceCents])
  }

  const medianByRule = new Map<number, number>()
  for (const [ruleId, rulePrices] of byRule) medianByRule.set(ruleId, medianOf(rulePrices))

  const valid = prices.filter(({ ruleId, priceCents }) => priceCents >= medianByRule.get(ruleId)! * 0.2)
  if (valid.length === 0) return null
  return Math.min(...valid.map((price) => price.priceCents))
}
