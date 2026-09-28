import type { Match } from '../api/types'
import { parseApiDate } from './dates'

/**
 * S14-08 (parte 2, rodada 2): which match "represents" a product when the
 * product panel needs to act on a *rule* (its "Avise-me abaixo de" target,
 * its silence state) — the panel itself only knows a `product_key`, not a
 * `rule_id`. The product's most recently `matched_at` match, same choice
 * `ProductPanel.handleEditData` already makes (via `newestPostingId`) for
 * "Editar dados", just against a `Match[]` the caller already has loaded
 * (FeedPage's live `matches`, HistoricoPage's filtered `matches`) instead of
 * a second `/matches` request.
 *
 * A product with more than one rule pointing at it therefore always edits
 * the newest rule's target/snooze, never an arbitrary or a stale one —
 * callers show which rule that is (`Rule.name` from `rule_id`) so a
 * multi-rule product never saves a target to the wrong rule silently.
 */
export function latestMatchForProduct(matches: Match[], productKey: string): Match | null {
  const productMatches = matches.filter((match) => match.product_key === productKey)
  if (productMatches.length === 0) return null
  return productMatches.reduce((newest, candidate) =>
    parseApiDate(candidate.matched_at) > parseApiDate(newest.matched_at) ? candidate : newest,
  )
}
