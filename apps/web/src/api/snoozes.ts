import { apiRequest, jsonHeaders } from './http'
import type { Snooze } from './types'

export const listSnoozes = (): Promise<Snooze[]> => apiRequest<Snooze[]>('/snoozes')

export const snoozeRule = (csrfToken: string, ruleId: number, days = 7): Promise<Snooze> =>
  apiRequest<Snooze>('/snoozes', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ scope: 'rule', rule_id: ruleId, days }),
  })

export const reactivateSnooze = (csrfToken: string, snoozeId: number): Promise<void> =>
  apiRequest<void>(`/snoozes/${snoozeId}`, {
    method: 'DELETE',
    headers: jsonHeaders(csrfToken),
  })
