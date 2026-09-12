import { apiRequest, jsonHeaders } from './http'
import type { Recipient } from './types'

export interface RecipientInput {
  name: string
  telegram_chat_id: string
  allowlisted?: boolean
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
