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
  message_link: string | null
  matched_at: string
  created_at: string
  deliveries: Delivery[]
  /** S7-06: computed fresh on every read from the rule's real match history —
   * never a value stored on the match itself. */
  is_lowest_price_ever: boolean
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
