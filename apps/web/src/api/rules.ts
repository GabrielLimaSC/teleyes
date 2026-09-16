import { apiRequest, jsonHeaders } from './http'
import type { Rule } from './types'

export interface RuleInput {
  name: string
  include_terms: string
  exclude_terms?: string | null
  max_price_cents?: number | null
}

export const listRules = (includeInactive = false): Promise<Rule[]> =>
  apiRequest<Rule[]>(`/rules${includeInactive ? '?include_inactive=true' : ''}`)

export const createRule = (csrfToken: string, input: RuleInput): Promise<Rule> =>
  apiRequest<Rule>('/rules', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const updateRule = (csrfToken: string, id: number, input: Partial<RuleInput>): Promise<Rule> =>
  apiRequest<Rule>(`/rules/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const pauseRule = (csrfToken: string, id: number): Promise<Rule> =>
  apiRequest<Rule>(`/rules/${id}/pause`, { method: 'POST', headers: jsonHeaders(csrfToken) })

export const deleteRule = (csrfToken: string, id: number): Promise<void> =>
  apiRequest<void>(`/rules/${id}`, { method: 'DELETE', headers: jsonHeaders(csrfToken) })

/** S10-04: apaga o histórico de matches (e deliveries) da regra — a regra
 * em si nunca é apagada. Retorna quantos matches saíram, pro toast de
 * confirmação. */
export const clearRuleMatches = (csrfToken: string, id: number): Promise<{ deleted: number }> =>
  apiRequest<{ deleted: number }>(`/rules/${id}/matches`, {
    method: 'DELETE',
    headers: jsonHeaders(csrfToken),
  })
