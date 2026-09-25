export interface Delivery {
  id: number
  recipient_id: number
  status: string
  delivered_at: string | null
  created_at: string
}

export interface Match {
  id: number
  source_id: number
  rule_id: number
  message_text: string
  price_cents: number | null
  /** S7-05: only ever both non-null together, when the message had two
   * explicit, distinct textual anchors ("à vista"/"pix" vs. "cartão"/
   * "parcelado"/"Nx de") — null/null for every other match. */
  price_cash_cents: number | null
  price_card_cents: number | null
  message_link: string | null
  matched_at: string
  created_at: string
  deliveries: Delivery[]
  /** S7-06: computed fresh on every read from the rule's real match history —
   * never a value stored on the match itself. */
  is_lowest_price_ever: boolean
  /** S7-11: other sources' ids that posted this same rule+price within the
   * grouping window (chained), only ever set on the representative card —
   * the other matches still exist, just excluded from this response. `null`
   * when nothing grouped with it. */
  grouped_source_ids: number[] | null
  /** S14-01: stable product identity derived from the message title
   * (`packages/rules/product.py`), `null` when no product title was
   * recognised. Key of `GET /products/{key}`. */
  product_key: string | null
  /** S14-01: lowest price per local day of this product over the last 90
   * days, oldest first, at most 30 points (consecutive days merged by their
   * lowest price). Empty without a product key or a priced match. */
  sparkline: PricePoint[]
  /** S14-03: the rule or the product (whichever this match has) is silenced
   * right now — show "Reativar" instead of the usual actions. Computed
   * fresh on every read, never stored. */
  snoozed: boolean
  /** S14-02 (F6): the match's rule's price target (`Rule.target_price_cents`,
   * null without one), whether this match's own price reached it, and how
   * far off it still is in percent — computed fresh on every read, never
   * persisted. `target_gap_pct` is `null` without a target or a price, `0`
   * once the target is hit. Items with `target_hit` sort first in `GET
   * /matches`' response. */
  target_price_cents: number | null
  target_hit: boolean
  target_gap_pct: number | null
  /** S14-05 (F5): "Visto em N fontes" — set only on the representative of a
   * duplicate group (same `product_key`+price within the grouping window,
   * deduped by real Telegram message identity). `1` and no `sources` for a
   * card that groups with nothing, including whenever the "Agrupar
   * duplicatas" toggle is off. Optional here (the backend always sends it,
   * defaulting to `1`) so older test fixtures that predate S14-05 keep
   * compiling without every one of them being touched. */
  seen_count?: number
  sources?: MatchSource[]
  /** Every match id this card stands for, representative included — always
   * at least `[id]`. Optional for the same fixture-compat reason as
   * `seen_count` above; consumers fall back to `[match.id]`. */
  grouped_match_ids?: number[]
  /** S14-05: deterministic fold key for the live UI — `useLiveMatches`
   * intentionally never uses this as card identity (full reload on every
   * SSE event, per the Tech Lead's decision), so the frontend never reads
   * this field for that purpose. Kept only because the API always sends it. */
  group_key?: string | null
  /** S14-06 (F7): manual product edit fields — `display_name` takes
   * priority over the parsed title wherever a title is shown.
   * `price_source` feeds the "editado manualmente" chip (`'manual'` right
   * after an edit, `'parsed'` again once reverted, `null`/undefined for a
   * match never touched). Optional for the same fixture-compat reason as
   * `seen_count` above. */
  display_name?: string | null
  model_variant?: string | null
  price_source?: 'parsed' | 'manual' | null
  original_price_cents?: number | null
  last_correction?: MatchCorrection | null
}

/** S14-05 (F5): one distinct source of a duplicate group, in the order it
 * first posted. */
export interface MatchSource {
  id: number
  name: string
}

/** S14-06 (F7): who last edited/reverted a match, and when. */
export interface MatchCorrection {
  admin_id: number
  created_at: string
}

/** S14-04 (F4): `GET/PUT /digest` — the single `digest_settings` row, plus
 * "Próximo envio" and the pending queue for the panel. */
export interface DigestQueueItem {
  match_id: number
  price_cents: number | null
  title: string
  message_link: string | null
  matched_at: string
}

export interface DigestSettings {
  enabled: boolean
  send_at_local: string
  top_n: number
  mute_individual: boolean
  next_run_at_utc: string
  next_run_at_local: string
  queue_count: number
  queue: DigestQueueItem[]
}

/** S14-05 (F5): `GET/PUT /settings/feed` — for now, just the "Agrupar
 * duplicatas" toggle. */
export interface FeedSettings {
  group_duplicates: boolean
}

/** S14-01: lowest price of one day, `date` as `YYYY-MM-DD` in the
 * configured display timezone (persistence is always UTC). */
export interface PricePoint {
  date: string
  price_cents: number
}

export type ProductHistoryRange = '90d' | '30d' | '7d'

export interface ProductSource {
  id: number
  name: string
}

/** S14-01: one match of the product; `price_cents` null when no price was
 * extracted (still counted in `total_count`, never plotted). */
export interface ProductPosting {
  id: number
  source_id: number
  source_name: string
  price_cents: number | null
  matched_at: string
  message_link: string | null
}

/** S14-01: `GET /products/{key}?range=90d|30d|7d`. Statistics use fixed
 * windows (lowest/highest 90d, average 30d) whatever `range` the series
 * shows; `postings` is newest first, capped at 100 (`total_count` is the
 * real total). */
export interface Product {
  product_key: string
  title: string
  total_count: number
  sources: ProductSource[]
  first_seen_at: string
  current_price_cents: number | null
  current_price_at: string | null
  lowest_90d_cents: number | null
  average_30d_cents: number | null
  highest_90d_cents: number | null
  range: ProductHistoryRange
  series: PricePoint[]
  postings: ProductPosting[]
}

export interface Rule {
  id: number
  name: string
  include_terms: string
  exclude_terms: string | null
  max_price_cents: number | null
  /** S14-02 (F6): "Avise-me abaixo de" — the price alert target, `null`
   * without one. Always a strictly positive amount when set. */
  target_price_cents: number | null
  active: boolean
  created_at: string
  /** S7-06: the rule's true historical minimum among its own priced
   * matches, or `null` with no priced match yet. */
  lowest_price_cents: number | null
  /** S14-03: `until` of the rule's active snooze, `null` when it is not
   * silenced. Computed fresh on every read, never stored. */
  snoozed_until: string | null
}

/** S14-03: silences delivery for one rule or one product until `until` (F3).
 * The match itself is still persisted and shown on the feed; only the
 * delivery is suppressed. A new snooze for the same target replaces the
 * previous one instead of duplicating it. */
export interface Snooze {
  id: number
  scope: 'rule' | 'product'
  rule_id: number | null
  product_key: string | null
  until: string
  /** The rule's name, or the product's title from its most recent posting. */
  label: string
}

/** S13-07: one already-matched message (any existing rule, last
 * `window_days`) that the form's not-yet-saved terms would also catch. */
export interface RuleTestMatch {
  source_id: number
  source_name: string
  message_text: string
  price_cents: number | null
  price_cash_cents: number | null
  price_card_cents: number | null
  message_link: string | null
  matched_at: string
  /** The include term (as typed) that made this message match. */
  matched_term: string
}

/** S13-07: `POST /rules/test` response — `total_matched` counts every real
 * match in the window, `messages` is capped at the 50 most recent. */
export interface RuleTestResult {
  total_matched: number
  window_days: number
  messages: RuleTestMatch[]
}

export interface Source {
  id: number
  name: string
  telegram_chat_id: string
  active: boolean
  created_at: string
}

export interface Recipient {
  id: number
  name: string
  telegram_chat_id: string
  allowlisted: boolean
  active: boolean
  created_at: string
}
