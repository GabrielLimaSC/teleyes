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

/** S17-10: where a rule stands against its target, judged only on offers from
 * the last 24 h (`Rule.lowest_price_24h_cents`, the backend's own window) —
 * an older, expired offer never counts as "atingido".
 *  - `none`: the rule has no target.
 *  - `no-offer`: a target, but no priced offer in the last 24 h (neutral).
 *  - `hit`: a live offer at or below the target.
 *  - `gap`: a live offer above the target; `gapPct` is how far, in percent. */
export type RuleTargetState =
  | { kind: 'none' }
  | { kind: 'no-offer'; targetCents: number }
  | { kind: 'hit'; targetCents: number; priceCents: number }
  | { kind: 'gap'; targetCents: number; priceCents: number; gapPct: number }

export function ruleTargetState(rule: {
  target_price_cents: number | null
  lowest_price_24h_cents?: number | null
}): RuleTargetState {
  const targetCents = rule.target_price_cents
  if (targetCents === null) return { kind: 'none' }
  const priceCents = rule.lowest_price_24h_cents ?? null
  if (priceCents === null) return { kind: 'no-offer', targetCents }
  if (targetHit(priceCents, targetCents)) return { kind: 'hit', targetCents, priceCents }
  // At least 1%: a positive gap must never read "falta 0%".
  return { kind: 'gap', targetCents, priceCents, gapPct: Math.max(1, targetGapPct(priceCents, targetCents) ?? 1) }
}
