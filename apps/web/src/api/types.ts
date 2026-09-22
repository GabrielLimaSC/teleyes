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
