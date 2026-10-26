import { apiRequest } from './http'

export type AdapterState =
  | 'not_configured'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'blocked'
  | 'demo'

export interface HealthResponse {
  status: 'ok'
  env: string
  version: string
  uptime_seconds: number
  telegram: { configured: boolean; state: AdapterState }
  bot: { configured: boolean; state: 'configured' | 'not_configured' | 'demo' }
  /** True only when the API runs with TELEYES_DEMO=1 (S19-03). */
  demo?: boolean
}

export const fetchHealth = (): Promise<HealthResponse> => apiRequest<HealthResponse>('/health')
