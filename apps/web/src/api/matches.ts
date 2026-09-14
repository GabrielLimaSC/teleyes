import { ApiError } from './auth'
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
