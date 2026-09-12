import { apiRequest, jsonHeaders } from './http'
import type { Source } from './types'

export interface SourceInput {
  name: string
  telegram_chat_id: string
}

export const listSources = (includeInactive = false): Promise<Source[]> =>
  apiRequest<Source[]>(`/sources${includeInactive ? '?include_inactive=true' : ''}`)

export const createSource = (csrfToken: string, input: SourceInput): Promise<Source> =>
  apiRequest<Source>('/sources', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const updateSource = (
  csrfToken: string,
  id: number,
  input: Partial<SourceInput>,
): Promise<Source> =>
  apiRequest<Source>(`/sources/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })

export const pauseSource = (csrfToken: string, id: number): Promise<Source> =>
  apiRequest<Source>(`/sources/${id}/pause`, { method: 'POST', headers: jsonHeaders(csrfToken) })

export const deleteSource = (csrfToken: string, id: number): Promise<void> =>
  apiRequest<void>(`/sources/${id}`, { method: 'DELETE', headers: jsonHeaders(csrfToken) })
