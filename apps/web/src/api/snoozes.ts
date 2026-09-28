import { apiRequest, jsonHeaders } from './http'
import type { Snooze } from './types'

/** S14-03 (F3): silences delivery for one rule or one product until `until`.
 * A new snooze for the same target replaces the previous one server-side,
 * never duplicates it. */
export const listSnoozes = (): Promise<Snooze[]> => apiRequest<Snooze[]>('/snoozes')

export const snoozeRule = (csrfToken: string, ruleId: number, days = 7): Promise<Snooze> =>
  apiRequest<Snooze>('/snoozes', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ scope: 'rule', rule_id: ruleId, days }),
  })

/** S14-07: the card's "Silenciar 7 dias" — same endpoint as `snoozeRule`,
 * scope `'product'`, always `days: 7`. */
export const snoozeProduct = (csrfToken: string, productKey: string, days = 7): Promise<Snooze> =>
  apiRequest<Snooze>('/snoozes', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ scope: 'product', product_key: productKey, days }),
  })

export const reactivateSnooze = (csrfToken: string, snoozeId: number): Promise<void> =>
  apiRequest<void>(`/snoozes/${snoozeId}`, {
    method: 'DELETE',
    headers: jsonHeaders(csrfToken),
  })
