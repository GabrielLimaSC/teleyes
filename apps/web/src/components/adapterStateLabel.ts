import type { AdapterState } from '../api/health'

export interface StateLabel {
  label: string
  color: string
}

const TELEGRAM_STATE_LABELS: Record<AdapterState, StateLabel> = {
  not_configured: { label: 'Não configurado', color: '#8a8a92' },
  connecting: { label: 'Conectando…', color: '#8a6d00' },
  connected: { label: 'Conectado', color: '#1c8a4b' },
  reconnecting: { label: 'Reconectando…', color: '#8a6d00' },
  blocked: { label: 'Bloqueado', color: '#b3261e' },
}

export function telegramStateLabel(state: AdapterState): StateLabel {
  return TELEGRAM_STATE_LABELS[state]
}

export function botStateLabel(state: 'configured' | 'not_configured'): StateLabel {
  return state === 'configured'
    ? { label: 'Configurado', color: '#1c8a4b' }
    : { label: 'Não configurado', color: '#8a8a92' }
}
