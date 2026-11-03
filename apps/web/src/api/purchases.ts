import { apiRequest, jsonHeaders } from './http'

/** S19-04: a purchase the admin registered by hand. Never holds Telegram
 * content (no message text, link or group name). */
export interface Purchase {
  id: number
  name: string
  price_cents: number
  purchased_at: string
  store: string | null
  product_key: string | null
  rule_id: number | null
  created_at: string
}

export interface PurchaseInput {
  name: string
  price_cents: number
  purchased_at: string
  store: string | null
  product_key: string | null
  rule_id: number | null
}

export interface ItemSavings {
  status: 'ok' | 'no_data'
  samples_90d: number
  samples_30d: number
  median_30d_cents: number | null
  average_30d_cents: number | null
  median_90d_cents: number | null
  average_90d_cents: number | null
  lowest_seen_cents: number | null
  highest_seen_cents: number | null
  usual_price_cents: number | null
  /** Negative when more was paid than the median: shown as such, never hidden. */
  saving_vs_median_cents: number | null
  saving_vs_median_pct: number | null
  saving_vs_usual_cents: number | null
  saving_vs_usual_pct: number | null
}

export interface ReportItem {
  id: number
  name: string
  store: string | null
  price_cents: number
  purchased_at: string
  linked: boolean
  days_before_black_friday: number
  /** `null` for a purchase with no product/rule link: only the amount paid. */
  savings: ItemSavings | null
  /** Saving of this purchase / goal amount in % (negative when overpaid); `null` without goal or history. */
  share_of_goal?: number | null
}

export interface ReportTotals {
  purchases: number
  linked_with_data: number
  total_paid_cents: number
  estimated_saving_cents: number
  reference_total_cents: number
  estimated_saving_pct: number | null
}

export interface BlackFridaySummary {
  date: string
  is_default: boolean
  purchases_before: number
  days_before_min: number | null
  days_before_max: number | null
}

export type GoalPace = 'done' | 'on_track' | 'behind' | 'expired'

export interface GoalReport {
  amount_cents: number
  deadline: string
  /** The estimated saving, possibly negative. */
  saved_cents: number
  /** Real ratio in %: may be below 0 or above 100 (the UI clamps it for the bar). */
  pct: number
  remaining_cents: number
  days_left: number
  pace: GoalPace
}

export interface SavingsGoal {
  amount_cents: number
  deadline: string
  created_at: string
  updated_at: string
}

export interface SavingsGoalInput {
  amount_cents: number
  deadline: string
}

export interface ReportNoise {
  period_start: string
  period_end: string
  counters_scope: 'all_time'
  messages_analyzed: number
  discarded: { sem_termo: number; bloqueado: number; preco_acima_teto: number }
  alerts_matched: number
  duplicates_grouped: number
  alerts_sent: number
}

export interface SavingsReport {
  generated_at: string
  totals: ReportTotals
  black_friday: BlackFridaySummary
  goal?: GoalReport | null
  items: ReportItem[]
  noise: ReportNoise
}

export const listPurchases = (): Promise<Purchase[]> => apiRequest<Purchase[]>('/purchases')

export const createPurchase = (csrfToken: string, input: PurchaseInput): Promise<Purchase> =>
  apiRequest<Purchase>('/purchases', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const updatePurchase = (csrfToken: string, id: number, input: PurchaseInput): Promise<Purchase> =>
  apiRequest<Purchase>(`/purchases/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const deletePurchase = (csrfToken: string, id: number): Promise<void> =>
  apiRequest<void>(`/purchases/${id}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  })

export const fetchSavingsReport = (): Promise<SavingsReport> => apiRequest<SavingsReport>('/savings/report')

export const saveSavingsGoal = (csrfToken: string, input: SavingsGoalInput): Promise<SavingsGoal> =>
  apiRequest<SavingsGoal>('/savings/goal', {
    method: 'PUT',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const deleteSavingsGoal = (csrfToken: string): Promise<void> =>
  apiRequest<void>('/savings/goal', {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  })
