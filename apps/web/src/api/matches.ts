import { ApiError } from './auth'
import { apiRequest, jsonHeaders } from './http'
import type { Match } from './types'

export type MatchSort = 'price_asc' | 'price_desc'

export interface MatchFilters {
  ruleId?: number
  sourceId?: number
  recipientId?: number
  minPriceCents?: number
  maxPriceCents?: number
  deliveryStatus?: string
  sort?: MatchSort
}

export interface MatchCorrection {
  admin_id: number
  created_at: string
}

export interface EditableMatch extends Match {
  display_name: string | null
  model_variant: string | null
  price_source: 'parsed' | 'manual' | null
  original_price_cents: number | null
  last_correction: MatchCorrection | null
}

export interface MatchUpdateInput {
  display_name?: string
  model_variant?: string
  price?: string
  apply_name_to_product?: boolean
}

export function buildMatchQuery(filters: MatchFilters): string {
  const params = new URLSearchParams()
  if (filters.ruleId !== undefined) params.set('rule_id', String(filters.ruleId))
  if (filters.sourceId !== undefined) params.set('source_id', String(filters.sourceId))
  if (filters.recipientId !== undefined) params.set('recipient_id', String(filters.recipientId))
  if (filters.minPriceCents !== undefined) params.set('min_price_cents', String(filters.minPriceCents))
  if (filters.maxPriceCents !== undefined) params.set('max_price_cents', String(filters.maxPriceCents))
  if (filters.deliveryStatus !== undefined) params.set('delivery_status', filters.deliveryStatus)
  if (filters.sort !== undefined) params.set('sort', filters.sort)
  return params.toString()
}

export async function fetchMatches(filters: MatchFilters = {}): Promise<Match[]> {
  const query = buildMatchQuery(filters)
  const response = await fetch(`/matches${query ? `?${query}` : ''}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new ApiError('Não foi possível carregar os matches.', response.status)
  }
  return (await response.json()) as Match[]
}

export async function fetchEditableMatches(filters: MatchFilters = {}): Promise<EditableMatch[]> {
  return (await fetchMatches(filters)) as EditableMatch[]
}

export function updateMatch(
  csrfToken: string,
  matchId: number,
  input: MatchUpdateInput,
): Promise<EditableMatch> {
  return apiRequest<EditableMatch>(`/matches/${matchId}`, {
    method: 'PATCH',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify(input),
  })
}

export function revertMatch(csrfToken: string, matchId: number): Promise<EditableMatch> {
  return apiRequest<EditableMatch>(`/matches/${matchId}/revert`, {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
  })
}
