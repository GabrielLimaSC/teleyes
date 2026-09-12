import { apiRequest } from './http'

export type AdapterState = 'not_configured' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'

export interface HealthResponse {
  status: 'ok'
  env: string
  version: string
  uptime_seconds: number
  telegram: { configured: boolean; state: AdapterState }
  bot: { configured: boolean; state: 'configured' | 'not_configured' }
}

export const fetchHealth = (): Promise<HealthResponse> => apiRequest<HealthResponse>('/health')
