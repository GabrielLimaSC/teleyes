/**
 * S14-07: mirrors `packages/rules/target.py` exactly (same floor-division
 * formula) so the sidebar's "Alvos de preço" — a per-rule aggregate the
 * backend has no endpoint for — never disagrees with what a match's own
 * `target_hit`/`target_gap_pct` fields already say about that same rule.
 */

export function targetHit(priceCents: number | null, targetPriceCents: number | null): boolean {
  return priceCents !== null && targetPriceCents !== null && priceCents <= targetPriceCents
}

/** Integer percent still missing to reach the target, floored — `null`
 * without a target/price, `0` once hit. */
export function targetGapPct(priceCents: number | null, targetPriceCents: number | null): number | null {
  if (priceCents === null || targetPriceCents === null || targetPriceCents <= 0) return null
  if (priceCents <= targetPriceCents) return 0
  return Math.floor(((priceCents - targetPriceCents) * 100) / targetPriceCents)
}
