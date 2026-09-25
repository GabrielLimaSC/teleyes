import { apiRequest, jsonHeaders } from './http'
import type { Snooze } from './types'

/** S14-03 (F3): `POST /snoozes` — silences delivery for one rule or one
 * product for `days` (the card's "Silenciar 7 dias" always sends `days: 7`,
 * scope `'product'`; the sidebar's rule-scoped snoozes go through the same
 * endpoint with `scope: 'rule'`). A new snooze for the same target replaces
 * the previous one server-side, never duplicates it. */
export interface SnoozeCreateInput {
  scope: 'rule' | 'product'
  ruleId?: number
  productKey?: string
  days: number
}

function snoozeBody(input: SnoozeCreateInput): Record<string, unknown> {
  return {
    scope: input.scope,
    rule_id: input.ruleId ?? null,
    product_key: input.productKey ?? null,
    days: input.days,
  }
}

export const fetchSnoozes = (): Promise<Snooze[]> => apiRequest<Snooze[]>('/snoozes')

export const createSnooze = (csrfToken: string, input: SnoozeCreateInput): Promise<Snooze> =>
  apiRequest<Snooze>('/snoozes', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(snoozeBody(input)),
  })

export const deleteSnooze = (csrfToken: string, id: number): Promise<void> =>
  apiRequest<void>(`/snoozes/${id}`, { method: 'DELETE', headers: jsonHeaders(csrfToken) })
