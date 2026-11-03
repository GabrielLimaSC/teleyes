import { apiRequest, jsonHeaders } from './http'
import type { Recipient, RecipientPreview, RulesMode } from './types'

export interface RecipientInput {
  name: string
  telegram_chat_id: string
  allowlisted?: boolean
  rules_mode?: RulesMode
  rule_ids?: number[]
  notify_target?: boolean
  notify_common?: boolean
}

export interface PreviewParams {
  rules_mode: RulesMode
  rule_ids: number[]
  notify_target: boolean
  notify_common: boolean
}

/** S21-06: "~N alertas/semana" for settings that are still being edited. */
export const previewRecipient = (params: PreviewParams): Promise<RecipientPreview> => {
  const query = new URLSearchParams({
    rules_mode: params.rules_mode,
    notify_target: String(params.notify_target),
    notify_common: String(params.notify_common),
  })
  if (params.rule_ids.length > 0) query.set('rule_ids', params.rule_ids.join(','))
  return apiRequest<RecipientPreview>(`/recipients/preview?${query.toString()}`)
}

export const listRecipients = (includeInactive = false): Promise<Recipient[]> =>
  apiRequest<Recipient[]>(`/recipients${includeInactive ? '?include_inactive=true' : ''}`)

export const createRecipient = (csrfToken: string, input: RecipientInput): Promise<Recipient> =>
  apiRequest<Recipient>('/recipients', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const updateRecipient = (
  csrfToken: string,
  id: number,
  input: Partial<RecipientInput>,
): Promise<Recipient> =>
  apiRequest<Recipient>(`/recipients/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const pauseRecipient = (csrfToken: string, id: number): Promise<Recipient> =>
  apiRequest<Recipient>(`/recipients/${id}/pause`, { method: 'POST', headers: jsonHeaders(csrfToken) })

export const deleteRecipient = (csrfToken: string, id: number): Promise<void> =>
  apiRequest<void>(`/recipients/${id}`, { method: 'DELETE', headers: jsonHeaders(csrfToken) })
