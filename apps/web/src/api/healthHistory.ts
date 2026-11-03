import { apiRequest } from './http'

export type ServiceKey = 'telegram' | 'bot' | 'listener' | 'sse' | 'db'

/** One hour of one service; `ok`/`total` both `null` = nothing measured ("coletando"). */
export interface HeartbeatBucket {
  hour: string
  ok: number | null
  total: number | null
}

export interface ServiceHistory {
  service: ServiceKey
  buckets: HeartbeatBucket[]
}

export interface CollectorHour {
  hour: string
  seen: number | null
  evaluated: number | null
}

export interface CollectorHistory {
  coverage_since: string | null
  hours: CollectorHour[]
  totals: {
    seen: number
    evaluated: number
    discarded: number
    delivery_failures: number
    delivery_failures_last_hour: number
  }
}

export interface HealthHistory {
  hours: number
  coverage_since: string | null
  services: ServiceHistory[]
  collector: CollectorHistory
}

export type SystemEventKind =
  | 'match_target'
  | 'sse_reconnect'
  | 'rules_applied'
  | 'backup'
  | 'test_send'
  | 'listener_reconnect'
  | 'delivery_failure'

export interface SystemEvent {
  id: number
  at: string
  kind: SystemEventKind
  summary: string
}

export const fetchHealthHistory = (hours = 24): Promise<HealthHistory> =>
  apiRequest<HealthHistory>(`/health/history?hours=${hours}`)

export const fetchHealthEvents = (limit = 20): Promise<SystemEvent[]> =>
  apiRequest<SystemEvent[]>(`/health/events?limit=${limit}`)
