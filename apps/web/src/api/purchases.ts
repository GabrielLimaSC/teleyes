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

/** `blackFriday` is a `YYYY-MM-DD` day; omitted, the server picks the default
 * (the day after the 4th Thursday of November of the latest purchase's year). */
export const fetchSavingsReport = (blackFriday?: string): Promise<SavingsReport> =>
  apiRequest<SavingsReport>(
    `/savings/report${blackFriday ? `?black_friday=${encodeURIComponent(blackFriday)}` : ''}`,
  )
