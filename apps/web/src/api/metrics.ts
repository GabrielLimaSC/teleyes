import { apiRequest } from './http'

/** Mirrors `packages/metrics/counters.py`'s `MetricReason` — fixed categorical
 * reasons, never free text. */
export type MetricReason = 'vista' | 'sem_termo' | 'bloqueado' | 'preco_acima_teto' | 'falha_entrega'

export interface MetricCounter {
  source_id: number | null
  reason: MetricReason
  count: number
  updated_at: string
}

/** One row per (source_id | null, reason) combination — cumulative counters
 * since the database existed, never reset, never scoped to "hoje". Sum the
 * rows for a given reason to get the system-wide total. */
export const fetchMetrics = (): Promise<MetricCounter[]> => apiRequest<MetricCounter[]>('/metrics')
