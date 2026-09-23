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
